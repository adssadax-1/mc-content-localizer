//! Java `.class` 常量池的**只读解析**与**安全改写**。
//!
//! # 为什么需要它
//!
//! 模组里的可翻译文本有两条完全不同的来源：
//!
//! * `Component.translatable("key")` —— 代码**主动查表**，语言文件
//!   （`assets/<ns>/lang/zh_cn.json`）和资源包都能覆盖；
//! * `ldc "Player Render"` —— 字面量被编译进 `.class` 的常量池，
//!   **代码从来没有"查表"这个动作**，任何语言文件、任何资源包都够不着。
//!
//! 后者就是"不改动就永远不生效"的那一类：唯一办法是把常量池里的字节换掉。
//! 本模块提供这一步，并且把"哪些字节可以安全地换"这件事做成可判定的。
//!
//! # 安全边界（每一条都对应一个会让 class 报废的坑）
//!
//! 1. **只改「被 `CONSTANT_String` 引用」且「不作为名字使用」的 `CONSTANT_Utf8`。**
//!    常量池里 Utf8 身兼两职：字符串字面量 **和** 字段名 / 方法名 / 描述符 /
//!    类名 / 属性名。改到后者 = `NoSuchFieldError` / `NoSuchMethodError` /
//!    `ClassFormatError`。判据是"谁引用了它"，而且必须**连尾部结构一起看** ——
//!    字段名、方法名、属性名是**从尾部直接引用** Utf8 的，不经过任何常量池条目，
//!    只查 `Class` / `NameAndType` 会漏掉它们（`tail_name_refs` 就是补这一刀）。
//! 2. **绝不改动常量池的顺序、数量、槽位数与任何索引** —— 只替换 Utf8 的字节内容
//!    并重算 `u2` 长度前缀。于是 `Code` 里的 `ldc` 下标、`BootstrapMethods` 的
//!    参数、字段/方法引用全部继续有效；`Code` 属性里不存字节偏移，所以
//!    `StackMapTable` 也不需要动（这正是不引入 `VerifyError` 的原因）。
//! 3. **长度前缀必须重算**：中文的 UTF-8 字节数与英文不同，"等长原地覆盖"做不到，
//!    这也是很多简易实现改写中文就崩的原因。
//! 4. **修改版 UTF-8**：BMP 且无 `U+0000` 时与标准 UTF-8 完全一致；
//!    非 BMP 需写成代理对（非规范编码，严格解码器会拒绝）；`U+0000` 要写 `C0 80`。
//!    编码侧照做，解码侧一律走 lossy，避免因个别编码异常丢掉整批扫描结果。
//! 5. `StringConcatFactory` 的 `\u0001` / `\u0002` 占位符属于字面量内容本身，
//!    由调用方保证不在替换时拆分或丢弃（本项目只整串替换）。

use std::collections::{HashMap, HashSet};

// ── 常量池 tag（JVM 规范 §4.4） ────────────────────────────────────────────────
const TAG_UTF8: u8 = 1;
const TAG_INTEGER: u8 = 3;
const TAG_FLOAT: u8 = 4;
const TAG_LONG: u8 = 5;
const TAG_DOUBLE: u8 = 6;
const TAG_CLASS: u8 = 7;
const TAG_STRING: u8 = 8;
const TAG_FIELDREF: u8 = 9;
const TAG_METHODREF: u8 = 10;
const TAG_IMETHODREF: u8 = 11;
const TAG_NAMEANDTYPE: u8 = 12;
const TAG_METHODHANDLE: u8 = 15;
const TAG_METHODTYPE: u8 = 16;
const TAG_DYNAMIC: u8 = 17;
const TAG_INVOKEDYNAMIC: u8 = 18;
const TAG_MODULE: u8 = 19;
const TAG_PACKAGE: u8 = 20;

const CLASS_MAGIC: [u8; 4] = [0xCA, 0xFE, 0xBA, 0xBE];

/// 一个常量池槽位在原始字节里的位置。`off`/`len` 指向**载荷**（Utf8 为字符串字节）。
#[derive(Debug, Clone, Copy)]
struct Slot {
    tag: u8,
    off: usize,
    len: usize,
}

/// 已解析的 class 常量池（借用原始字节，不做任何拷贝）。
pub struct ClassPool<'a> {
    buf: &'a [u8],
    /// 1-based，与 JVM 一致；`None` 表示 long / double 占用的第二个空槽
    slots: Vec<Option<Slot>>,
    count: u16,
    /// 常量池结束的字节偏移（尾部结构的起点）
    pool_end: usize,
}

impl<'a> ClassPool<'a> {
    /// 解析常量池。任何越界/未知 tag/结构不完整都返回 `Err` —— 宁可跳过这个 class，
    /// 也不要基于半懂的数据去改字节。
    pub fn parse(buf: &'a [u8]) -> Result<Self, String> {
        if buf.len() < 10 || buf[..4] != CLASS_MAGIC {
            return Err("不是 class 文件（魔数不匹配）".to_string());
        }
        let count = u16::from_be_bytes([buf[8], buf[9]]);
        if count == 0 {
            return Err("常量池计数为 0，文件已损坏".to_string());
        }
        let mut slots: Vec<Option<Slot>> = vec![None; count as usize];
        let mut pos = 10usize;
        let mut i = 1usize;
        while i < count as usize {
            if pos >= buf.len() {
                return Err("常量池提前结束".to_string());
            }
            let tag = buf[pos];
            pos += 1;
            let (len, two_slots) = match tag {
                TAG_UTF8 => {
                    if pos + 2 > buf.len() {
                        return Err("Utf8 长度前缀越界".to_string());
                    }
                    let n = u16::from_be_bytes([buf[pos], buf[pos + 1]]) as usize;
                    pos += 2;
                    (n, false)
                }
                TAG_INTEGER | TAG_FLOAT => (4, false),
                TAG_LONG | TAG_DOUBLE => (8, true),
                TAG_CLASS | TAG_STRING | TAG_METHODTYPE | TAG_MODULE | TAG_PACKAGE => (2, false),
                TAG_FIELDREF | TAG_METHODREF | TAG_IMETHODREF | TAG_NAMEANDTYPE
                | TAG_DYNAMIC | TAG_INVOKEDYNAMIC => (4, false),
                TAG_METHODHANDLE => (3, false),
                other => return Err(format!("未知常量池 tag={other}（偏移 {pos}）")),
            };
            if pos + len > buf.len() {
                return Err(format!(
                    "常量池 #{i}（tag={tag}）的载荷越界，文件可能被截断"
                ));
            }
            slots[i] = Some(Slot { tag, off: pos, len });
            pos += len;
            if two_slots {
                // long / double 占两个槽位，第二个槽位不存在对应条目
                i += 2;
            } else {
                i += 1;
            }
        }
        Ok(Self {
            buf,
            slots,
            count,
            pool_end: pos,
        })
    }

    /// 常量池条目总数（含未使用的第 0 号槽，与 JVM 的 `constant_pool_count` 同义）
    pub fn count(&self) -> u16 {
        self.count
    }

    fn slot(&self, idx: u16) -> Option<Slot> {
        self.slots.get(idx as usize).copied().flatten()
    }

    fn u2(&self, at: usize) -> u16 {
        u16::from_be_bytes([self.buf[at], self.buf[at + 1]])
    }

    /// 该索引指向的 Utf8 的原始字节；不是 Utf8 或越界返回 `None`。
    pub fn utf8_bytes(&self, idx: u16) -> Option<&'a [u8]> {
        let s = self.slot(idx)?;
        if s.tag != TAG_UTF8 {
            return None;
        }
        Some(&self.buf[s.off..s.off + s.len])
    }

    /// 被当作「名字」使用的 Utf8 索引集合。
    ///
    /// 两类来源都要算上：
    /// * 常量池里的名字宿主 —— `Class` / `MethodType` / `Module` / `Package`
    ///   的单个索引，`NameAndType` 的 name + descriptor **两个**索引；
    /// * **尾部结构的直接引用** —— 字段名/描述符、方法名/描述符、属性名。
    ///   这些不经过任何常量池条目，漏掉就会把字段名改成中文。
    pub fn name_owned(&self) -> Result<HashSet<u16>, String> {
        let mut used: HashSet<u16> = HashSet::new();
        for i in 1..self.count as usize {
            let Some(s) = self.slots[i] else { continue };
            match s.tag {
                TAG_CLASS | TAG_METHODTYPE | TAG_MODULE | TAG_PACKAGE => {
                    used.insert(self.u2(s.off));
                }
                TAG_NAMEANDTYPE => {
                    used.insert(self.u2(s.off));
                    used.insert(self.u2(s.off + 2));
                }
                _ => {}
            }
        }
        tail_name_refs(self.buf, self.pool_end, &mut used)?;
        Ok(used)
    }

    /// 可安全改写的字符串字面量：`原文原始字节 → [Utf8 索引]`。
    ///
    /// 只包含**被 `CONSTANT_String` 引用**且**不在 `name_owned` 里**的 Utf8。
    /// 用 `Vec<u16>` 而不是单个索引：常量池理论上允许出现内容相同的重复 Utf8，
    /// 那就一起改，避免只改一半。
    pub fn safe_literals(&self) -> Result<HashMap<Vec<u8>, Vec<u16>>, String> {
        let names = self.name_owned()?;
        let mut out: HashMap<Vec<u8>, Vec<u16>> = HashMap::new();
        for i in 1..self.count as usize {
            let Some(s) = self.slots[i] else { continue };
            if s.tag != TAG_STRING {
                continue;
            }
            let target = self.u2(s.off);
            if names.contains(&target) {
                continue; // 兼作名字 → 动不得
            }
            let Some(t) = self.slot(target) else { continue };
            if t.tag != TAG_UTF8 {
                continue;
            }
            out.entry(self.buf[t.off..t.off + t.len].to_vec())
                .or_default()
                .push(target);
        }
        Ok(out)
    }
}

/// 走一遍字段 / 方法 / 属性链表，收集尾部结构里直接引用的 Utf8 索引。
///
/// 同时起到**结构自检**作用：走完必须正好停在文件末尾，否则说明 class 已损坏，
/// 此时宁可报错也不要改写（改动一个自己都没看懂的文件等于赌博）。
fn tail_name_refs(buf: &[u8], pool_end: usize, out: &mut HashSet<u16>) -> Result<(), String> {
    let mut p = pool_end;
    let n = buf.len();

    // 只读捕获 buf/n，调用方负责推 p，所以是 Fn 而非 FnMut —— 不需要 `mut`。
    let rd2 = |p: &mut usize| -> Result<u16, String> {
        if *p + 2 > n {
            return Err("尾部结构提前结束，class 文件可能已损坏".to_string());
        }
        let v = u16::from_be_bytes([buf[*p], buf[*p + 1]]);
        *p += 2;
        Ok(v)
    };
    let attrs = |p: &mut usize, out: &mut HashSet<u16>| -> Result<(), String> {
        let cnt = u16::from_be_bytes([buf[*p], buf[*p + 1]]);
        *p += 2;
        for _ in 0..cnt {
            out.insert(u16::from_be_bytes([buf[*p], buf[*p + 1]])); // attribute_name_index
            *p += 2;
            let len = u32::from_be_bytes([buf[*p], buf[*p + 1], buf[*p + 2], buf[*p + 3]]);
            *p += 4;
            let len = len as usize;
            if *p + len > n {
                return Err("属性长度越界，class 文件可能已损坏".to_string());
            }
            *p += len; // 属性体原样跳过（不解析具体属性，索引不变即安全）
        }
        Ok(())
    };

    rd2(&mut p)?; // access_flags
    rd2(&mut p)?; // this_class
    rd2(&mut p)?; // super_class
    let ic = rd2(&mut p)?;
    for _ in 0..ic {
        rd2(&mut p)?; // interfaces
    }
    let fc = rd2(&mut p)?;
    for _ in 0..fc {
        rd2(&mut p)?; // access_flags
        out.insert(rd2(&mut p)?); // name_index
        out.insert(rd2(&mut p)?); // descriptor_index
        attrs(&mut p, out)?;
    }
    let mc = rd2(&mut p)?;
    for _ in 0..mc {
        rd2(&mut p)?; // access_flags
        out.insert(rd2(&mut p)?); // name_index
        out.insert(rd2(&mut p)?); // descriptor_index
        attrs(&mut p, out)?;
    }
    attrs(&mut p, out)?; // 类级属性
    if p != n {
        return Err("尾部结构未能铺满文件，class 文件可能已损坏".to_string());
    }
    Ok(())
}

/// 扫描用：按**常量池顺序**列出**全部** `CONSTANT_Utf8` 文本（含名字与描述符）。
///
/// ⚠️ 生产路径已不再使用它 —— 深度扫描走 [`scan_safe_strings`]，只认可安全改写的那些。
/// 保留在测试里当"常量池到底有多少 Utf8"的标尺（用来证明解析推进量准确），
/// 所以打了 `#[cfg(test)]`，避免发布产物里挂一个没人调的函数。
///
/// 解码刻意用 lossy：个别的非规范编码不应该让整批结果消失。
#[cfg(test)]
pub fn scan_strings(buf: &[u8]) -> Vec<String> {
    let Ok(cp) = ClassPool::parse(buf) else {
        return Vec::new();
    };
    (1..cp.count as usize)
        .filter_map(|i| cp.slots[i])
        .filter(|s| s.tag == TAG_UTF8)
        .map(|s| String::from_utf8_lossy(&buf[s.off..s.off + s.len]).into_owned())
        .collect()
}

/// 扫描用：按**常量池顺序**列出**可安全改写**的 `CONSTANT_Utf8` 文本，
/// 返回 `(Utf8 序号, 文本)`；序号口径与 [`scan_strings`] 一致，因此条目键里的
/// `#const:N` 不会因为这次收敛而整体挪位。
///
/// 只保留「被 `CONSTANT_String` 引用」且「不在 [`ClassPool::name_owned`] 里」的 Utf8，
/// 也就是 [`ClassPool::safe_literals`] 的同一批。放在扫描侧过滤有两个理由：
///
/// * **不产出注定落不了地的条目**。JVM 内部名（`Code` / `LineNumberTable` /
///   `SourceFile` / `StackMapTable` / `Signature` …）在常量池里同样是 Utf8、同样是
///   首字母大写的单词，形态与按钮标签别无二致；它们能过打分门槛混进列表，却必然
///   在改写时被按名字拒绝。让用户为这些条目花 API 钱，是"已翻译覆盖率"虚高的来源之一。
/// * **扫描与导出用同一把尺子**：扫描留下的每一条，导出时都真的能改写。
///
/// 解码刻意用 lossy：个别的非规范编码不应该让整批结果消失。
pub fn scan_safe_strings(buf: &[u8]) -> Vec<(usize, String)> {
    let Ok(cp) = ClassPool::parse(buf) else {
        return Vec::new();
    };
    let Ok(names) = cp.name_owned() else {
        return Vec::new();
    };
    // 被 CONSTANT_String 引用的 Utf8 索引
    let mut in_string: HashSet<u16> = HashSet::new();
    for i in 1..cp.count as usize {
        if let Some(s) = cp.slots[i] {
            if s.tag == TAG_STRING {
                in_string.insert(cp.u2(s.off));
            }
        }
    }
    let mut out = Vec::new();
    let mut ord = 0usize;
    for i in 1..cp.count as usize {
        let Some(s) = cp.slots[i] else { continue };
        if s.tag != TAG_UTF8 {
            continue;
        }
        ord += 1; // 序号在所有 Utf8 上连续，与 scan_strings 对齐
        let idx = i as u16;
        if !in_string.contains(&idx) || names.contains(&idx) {
            continue;
        }
        out.push((
            ord,
            String::from_utf8_lossy(&buf[s.off..s.off + s.len]).into_owned(),
        ));
    }
    out
}

/// 标准 UTF-8 字符串 → **修改版 UTF-8** 字节。
///
/// * BMP 且不含 `U+0000`：与标准 UTF-8 完全一致（中文直接可用）；
/// * 非 BMP（emoji 等）：写成 CESU-8 风格的代理对 —— 这是 MUTF-8 的规范做法；
/// * `U+0000`：写成 `C0 80`（MUTF-8 不允许裸 NUL 字节）。
pub fn mutf8_encode(s: &str) -> Vec<u8> {
    fn push3(out: &mut Vec<u8>, cp: u32) {
        out.push(0xE0 | (cp >> 12) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    }
    let mut out = Vec::with_capacity(s.len() + 4);
    for ch in s.chars() {
        let cp = ch as u32;
        match cp {
            0 => {
                out.push(0xC0);
                out.push(0x80);
            }
            0x0001..=0x007F => out.push(cp as u8),
            0x0080..=0x07FF => {
                out.push(0xC0 | (cp >> 6) as u8);
                out.push(0x80 | (cp & 0x3F) as u8);
            }
            0x0800..=0xFFFF => push3(&mut out, cp),
            _ => {
                // 非 BMP：U+10000 以上，转成一对 3 字节代理
                let v = cp - 0x1_0000;
                push3(&mut out, 0xD800 + (v >> 10));
                push3(&mut out, 0xDC00 + (v & 0x3FF));
            }
        }
    }
    out
}

/// 改写结果统计，供导出层做用户可见的提示。
#[derive(Debug, Default, Clone, Copy)]
pub struct RewriteStat {
    /// 成功改写的字面量处数
    pub rewritten: usize,
    /// 想在语言表里找到、但这个 class 里没有（或不可安全改写）的条数
    pub unmatched: usize,
    /// 因为"兼作名字"被拒绝改写的条数
    pub shadowed: usize,
}

/// 按 `{Utf8 索引: 新文本}` 改写常量池，返回新的 class 字节。
///
/// 除被点名的 Utf8 之外，**每一个字节**都与输入相同（池结构、尾部结构原封不动），
/// 因此 `ldc` 索引、`BootstrapMethods` 参数、字段/方法引用全部继续有效。
pub fn rewrite(buf: &[u8], changes: &HashMap<u16, String>) -> Result<Vec<u8>, String> {
    let cp = ClassPool::parse(buf)?;
    if changes.is_empty() {
        return Ok(buf.to_vec());
    }
    let names = cp.name_owned()?;
    for idx in changes.keys() {
        let Some(s) = cp.slot(*idx) else {
            return Err(format!("常量池 #{idx} 不存在"));
        };
        if s.tag != TAG_UTF8 {
            return Err(format!("常量池 #{idx} 不是 Utf8，拒绝改写"));
        }
        if names.contains(idx) {
            return Err(format!("常量池 #{idx} 被当作名字使用，拒绝改写"));
        }
    }

    let mut out = Vec::with_capacity(buf.len() + 64);
    out.extend_from_slice(&buf[..8]); // magic + minor + major
    out.extend_from_slice(&cp.count.to_be_bytes());
    for i in 1..cp.count as usize {
        let Some(s) = cp.slots[i] else { continue }; // long/double 的第二槽
        out.push(s.tag);
        if s.tag == TAG_UTF8 {
            let raw: Vec<u8> = match changes.get(&(i as u16)) {
                Some(t) => mutf8_encode(t),
                None => buf[s.off..s.off + s.len].to_vec(),
            };
            if raw.len() > u16::MAX as usize {
                return Err(format!("常量池 #{i} 改写后超过 65535 字节"));
            }
            out.extend_from_slice(&(raw.len() as u16).to_be_bytes());
            out.extend_from_slice(&raw);
        } else {
            out.extend_from_slice(&buf[s.off..s.off + s.len]);
        }
    }
    out.extend_from_slice(&buf[cp.pool_end..]); // 尾部结构原样保留

    // 自检：改完必须仍能被同一套解析走通，并且尾部结构一点没动。
    // 宁可放弃改写（返回 Err 让调用方写回原字节），也不要产出一个坏 class。
    let cp2 = ClassPool::parse(&out)?;
    cp2.name_owned()?;
    // 尾部逐字节相同 —— 这一条同时蕴含"尾部长度不变"，
    // 因此不必再去算两边的差值（那地方很容易写成有符号/无符号混用）。
    if out[cp2.pool_end..] != buf[cp.pool_end..] {
        return Err("改写后尾部结构发生了变化，已放弃".to_string());
    }
    Ok(out)
}

/// 对一个 class 应用「原文 → 译文」表，内部完成 safe_literals 匹配与计数。
///
/// 匹配**按原文内容**而不是按下标：这样即使扫描时的序号与当下的常量池对不上，
/// 也不会改错东西 —— 最多是跳过（计入 `unmatched`）。这是"宁可漏改，不可错改"。
pub fn apply_translations(buf: &[u8], table: &HashMap<Vec<u8>, String>) -> (Vec<u8>, RewriteStat) {
    let mut stat = RewriteStat::default();
    if table.is_empty() {
        return (buf.to_vec(), stat);
    }
    let fail = |stat: &mut RewriteStat| {
        stat.unmatched = table.len();
        (buf.to_vec(), *stat)
    };
    let cp = match ClassPool::parse(buf) {
        Ok(c) => c,
        Err(_) => return fail(&mut stat),
    };
    let names = match cp.name_owned() {
        Ok(n) => n,
        Err(_) => return fail(&mut stat),
    };
    let safe = match cp.safe_literals() {
        Ok(s) => s,
        Err(_) => return fail(&mut stat),
    };
    // 兼作名字的 Utf8 文本集合：命中它说明这条"原文"其实还是字段名/方法名/描述符，
    // 属于安全策略主动拦下的，与"这个 class 里压根没有这段文本"要分开计数。
    let mut shadowed: HashSet<Vec<u8>> = HashSet::new();
    for i in 1..cp.count() as usize {
        if names.contains(&(i as u16)) {
            if let Some(b) = cp.utf8_bytes(i as u16) {
                shadowed.insert(b.to_vec());
            }
        }
    }

    let mut changes: HashMap<u16, String> = HashMap::new();
    for (text, tr) in table {
        if let Some(slots) = safe.get(text) {
            for s in slots {
                changes.insert(*s, tr.clone());
            }
        } else if shadowed.contains(text) {
            stat.shadowed += 1;
        } else {
            stat.unmatched += 1;
        }
    }
    if changes.is_empty() {
        return (buf.to_vec(), stat);
    }
    let skipped = stat.shadowed + stat.unmatched;
    match rewrite(buf, &changes) {
        Ok(new) => {
            stat.rewritten = changes.len();
            (new, stat)
        }
        Err(_) => {
            stat.rewritten = 0;
            stat.shadowed = 0;
            stat.unmatched = skipped + changes.len();
            (buf.to_vec(), stat)
        }
    }
}

/// ── 测试夹具：合成一个结构合法的 class ────────────────────────────────────────
///
/// 放在模块级（而不是 tests 里）是为了给 `export.rs` 的导出测试共用 ——
/// 同一个夹具同时验证"解析器认得它"和"导出链路上确实被改到"。
///
/// 内容安排：
/// * `Player Render` / `Scope: ` → 纯字面量（**可以**改写）
/// * `Armour` → 字面量 **且** 是字段名（只有尾部遍历能识别 → 必须拒改）
/// * `value`  → 字面量 **且** 是 NameAndType 的 name（池内遍历即可识别 → 必须拒改）
/// * `Code` / `LineNumberTable` / `SourceFile` / `I` / `run` / `()V` / 类名 → 只作名字
/// * 一个 `Long` 占两个槽位（验证槽位推进没有错位）
#[cfg(test)]
pub(crate) fn sample_class() -> Vec<u8> {
    fn u2(v: &mut Vec<u8>, x: u16) {
        v.extend_from_slice(&x.to_be_bytes());
    }
    fn u4(v: &mut Vec<u8>, x: u32) {
        v.extend_from_slice(&x.to_be_bytes());
    }
    fn utf8(v: &mut Vec<u8>, s: &str) {
        v.push(TAG_UTF8);
        u2(v, s.len() as u16);
        v.extend_from_slice(s.as_bytes());
    }

    let mut buf = Vec::new();
    buf.extend_from_slice(&CLASS_MAGIC);
    u2(&mut buf, 0); // minor
    u2(&mut buf, 61); // major
    u2(&mut buf, 24); // constant_pool_count

    utf8(&mut buf, "T"); // #1
    buf.push(TAG_CLASS);
    u2(&mut buf, 1); // #2 Class #1
    utf8(&mut buf, "java/lang/Object"); // #3
    buf.push(TAG_CLASS);
    u2(&mut buf, 3); // #4 Class #3
    utf8(&mut buf, "Player Render"); // #5 纯字面量
    buf.push(TAG_STRING);
    u2(&mut buf, 5); // #6 String #5
    utf8(&mut buf, "Armour"); // #7 字面量 + 字段名
    buf.push(TAG_STRING);
    u2(&mut buf, 7); // #8 String #7
    utf8(&mut buf, "value"); // #9 字面量 + NameAndType 名字
    buf.push(TAG_STRING);
    u2(&mut buf, 9); // #10 String #9
    utf8(&mut buf, "I"); // #11 字段描述符
    utf8(&mut buf, "Code"); // #12 属性名
    utf8(&mut buf, "LineNumberTable"); // #13 属性名
    utf8(&mut buf, "SourceFile"); // #14 属性名
    utf8(&mut buf, "T.java"); // #15
    utf8(&mut buf, "run"); // #16 方法名
    utf8(&mut buf, "()V"); // #17 方法描述符
    buf.push(TAG_NAMEANDTYPE);
    u2(&mut buf, 9); // #18 NameAndType(name=#9, desc=#17)
    u2(&mut buf, 17);
    buf.push(TAG_METHODREF);
    u2(&mut buf, 4); // #19 Methodref(class=#4, nat=#18)
    u2(&mut buf, 18);
    utf8(&mut buf, "Scope: "); // #20 纯字面量
    buf.push(TAG_STRING);
    u2(&mut buf, 20); // #21 String #20
    buf.push(TAG_LONG);
    buf.extend_from_slice(&[0u8; 8]); // #22(+#23) 占两个槽位

    // ── 尾部结构 ──
    u2(&mut buf, 0x0021); // access_flags
    u2(&mut buf, 2); // this_class
    u2(&mut buf, 4); // super_class
    u2(&mut buf, 0); // interfaces_count
    u2(&mut buf, 1); // fields_count
    u2(&mut buf, 0x0002); // access_flags
    u2(&mut buf, 7); // name_index = "Armour"
    u2(&mut buf, 11); // descriptor_index = "I"
    u2(&mut buf, 0); // attributes_count
    u2(&mut buf, 1); // methods_count
    u2(&mut buf, 0x0001); // access_flags
    u2(&mut buf, 16); // name_index = "run"
    u2(&mut buf, 17); // descriptor_index = "()V"
    u2(&mut buf, 1); // attributes_count
    u2(&mut buf, 12); // attribute_name_index = "Code"
    u4(&mut buf, 27); // attribute_length
    u2(&mut buf, 1); // max_stack
    u2(&mut buf, 1); // max_locals
    u4(&mut buf, 3); // code_length
    buf.extend_from_slice(&[0x12, 0x00, 0x06]); // ldc #6
    u2(&mut buf, 0); // exception_table_length
    u2(&mut buf, 1); // attributes_count（Code 内）
    u2(&mut buf, 13); // attribute_name_index = "LineNumberTable"
    u4(&mut buf, 6); // attribute_length
    u2(&mut buf, 1); // line_number_table_length
    u2(&mut buf, 0); // start_pc
    u2(&mut buf, 1); // line_number
    u2(&mut buf, 1); // 类级 attributes_count
    u2(&mut buf, 14); // attribute_name_index = "SourceFile"
    u4(&mut buf, 2); // attribute_length
    u2(&mut buf, 15); // sourcefile_index
    buf
}

/// 测试夹具：构造一个**结构合法且能被扫描**的极简 `.class`。
///
/// 每条 `strings` 都写成一对 `CONSTANT_Utf8` + 指向它的 `CONSTANT_String`，
/// 尾部（字段 / 方法 / 属性链表）为空但规范闭合。
///
/// ⚠️ 不要图省事只写常量池：扫描侧的 [`scan_safe_strings`] 只认「被
/// `CONSTANT_String` 引用且不被当作名字」的 Utf8，而"是不是名字"要靠
/// [`ClassPool::name_owned`] 走通尾部结构才能判断 —— 尾部缺失会被判成损坏文件，
/// 于是一个字符串都扫不出来。要造更多形态的样本请用本函数，别再手搓裸池。
#[cfg(test)]
pub(crate) fn fake_class(strings: &[&str]) -> Vec<u8> {
    let mut b = CLASS_MAGIC.to_vec();
    b.extend_from_slice(&0u16.to_be_bytes()); // minor_version
    b.extend_from_slice(&61u16.to_be_bytes()); // major_version（Java 17）
    // 布局：#1 空 Utf8（给 this_class 用，避免出现 0 号索引）；
    // 之后第 k 条字符串占 #(2+2k)=Utf8 与 #(3+2k)=String。
    let entries = 1 + strings.len() * 2;
    b.extend_from_slice(&((entries + 1) as u16).to_be_bytes());
    b.push(TAG_UTF8);
    b.extend_from_slice(&0u16.to_be_bytes());
    for (k, s) in strings.iter().enumerate() {
        let utf8_idx = (2 + k * 2) as u16;
        let bytes = s.as_bytes();
        b.push(TAG_UTF8);
        b.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        b.extend_from_slice(bytes);
        b.push(TAG_STRING);
        b.extend_from_slice(&utf8_idx.to_be_bytes());
    }
    // 尾部结构：空字段 / 空方法 / 空属性 —— 正好停在文件末尾
    b.extend_from_slice(&0x0021u16.to_be_bytes()); // access_flags
    b.extend_from_slice(&1u16.to_be_bytes()); // this_class
    b.extend_from_slice(&1u16.to_be_bytes()); // super_class
    b.extend_from_slice(&0u16.to_be_bytes()); // interfaces_count
    b.extend_from_slice(&0u16.to_be_bytes()); // fields_count
    b.extend_from_slice(&0u16.to_be_bytes()); // methods_count
    b.extend_from_slice(&0u16.to_be_bytes()); // attributes_count
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pool_and_tail() {
        let buf = sample_class();
        let cp = ClassPool::parse(&buf).unwrap();
        assert_eq!(cp.count(), 24);
        // name_owned 内部的尾部遍历会校验"正好走到文件末尾"，
        // 所以这一行同时证明了常量池的字节推进量是准确的
        cp.name_owned().unwrap();
        assert!(cp.pool_end < buf.len());
        // 13 个 Utf8（#1 #3 #5 #7 #9 #11 #12 #13 #14 #15 #16 #17 #20）
        assert_eq!(scan_strings(&buf).len(), 13);
        // 扫描侧只交出"可安全改写"的那两条；序号与 scan_strings 口径一致
        // （"Player Render" 是第 3 个 Utf8，"Scope: " 是第 13 个），
        // 所以条目键里的 `#const:N` 不会因为这次收敛而整体挪位。
        assert_eq!(
            scan_safe_strings(&buf),
            vec![
                (3usize, "Player Render".to_string()),
                (13usize, "Scope: ".to_string()),
            ]
        );
    }

    #[test]
    fn safe_literals_excludes_name_owned() {
        let buf = sample_class();
        let cp = ClassPool::parse(&buf).unwrap();
        let safe = cp.safe_literals().unwrap();
        let mut keys: Vec<String> = safe
            .keys()
            .map(|k| String::from_utf8_lossy(k).into_owned())
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["Player Render".to_string(), "Scope: ".to_string()]);
        assert_eq!(safe.get(b"Player Render".as_slice()), Some(&vec![5u16]));
        // 字面量但兼作名字 → 必须排除
        assert!(safe.get(b"Armour".as_slice()).is_none());
        assert!(safe.get(b"value".as_slice()).is_none());
    }

    #[test]
    fn refuses_to_rewrite_names_and_non_utf8() {
        let buf = sample_class();
        let mut m = HashMap::new();
        m.insert(7u16, "护甲".to_string()); // 字段名 → 拒绝
        assert!(rewrite(&buf, &m).is_err());

        let mut m2 = HashMap::new();
        m2.insert(6u16, "x".to_string()); // String 条目，不是 Utf8 → 拒绝
        assert!(rewrite(&buf, &m2).is_err());

        let mut m3 = HashMap::new();
        m3.insert(999u16, "x".to_string()); // 越界 → 拒绝
        assert!(rewrite(&buf, &m3).is_err());
    }

    #[test]
    fn rewrite_changes_only_target_bytes_and_keeps_tail() {
        let buf = sample_class();
        let cp = ClassPool::parse(&buf).unwrap();
        let old_end = cp.pool_end;

        let mut m = HashMap::new();
        m.insert(5u16, "玩家渲染".to_string());
        let out = rewrite(&buf, &m).unwrap();

        let cp2 = ClassPool::parse(&out).unwrap();
        cp2.name_owned().unwrap();
        // 尾部结构逐字节不变
        assert_eq!(&out[cp2.pool_end..], &buf[old_end..]);
        // Code 里的 ldc #6 原样（索引未漂移）
        assert!(out.windows(3).any(|w| w == [0x12, 0x00, 0x06]));
        // 目标 Utf8 内容与长度前缀都按新内容重算
        let raw = cp2.utf8_bytes(5).unwrap();
        assert_eq!(raw, mutf8_encode("玩家渲染").as_slice());
        assert_eq!(raw.len(), 12);
        // 未点名的字面量原样
        assert_eq!(cp2.utf8_bytes(20).unwrap(), b"Scope: ");
        assert_eq!(cp2.utf8_bytes(9).unwrap(), b"value");
        // 索引与数量不变
        assert_eq!(cp2.count(), cp.count());
    }

    #[test]
    fn rewrite_is_noop_for_empty_changes() {
        let buf = sample_class();
        let out = rewrite(&buf, &HashMap::new()).unwrap();
        assert_eq!(out, buf);
    }

    #[test]
    fn mutf8_handles_bmp_astral_and_nul() {
        assert_eq!(mutf8_encode("A"), vec![0x41]);
        assert_eq!(mutf8_encode("玩"), vec![0xE7, 0x8E, 0xA9]);
        // 非 BMP → 代理对（每个代理 3 字节，共 6 字节）
        assert_eq!(mutf8_encode("😀").len(), 6);
        // NUL → C0 80
        assert_eq!(mutf8_encode("\u{0}"), vec![0xC0, 0x80]);
    }

    #[test]
    fn apply_translations_matches_by_text() {
        let buf = sample_class();
        let mut table: HashMap<Vec<u8>, String> = HashMap::new();
        table.insert(b"Player Render".to_vec(), "玩家渲染".to_string());
        table.insert(b"Scope: ".to_vec(), "范围：".to_string());
        table.insert(b"Armour".to_vec(), "护甲".to_string()); // 兼作名字 → 拒改
        table.insert(b"NotHere".to_vec(), "不存在".to_string()); // 未匹配

        let (out, stat) = apply_translations(&buf, &table);
        assert_eq!(stat.rewritten, 2);
        assert_eq!(stat.shadowed, 1);
        assert_eq!(stat.unmatched, 1);
        let cp = ClassPool::parse(&out).unwrap();
        assert_eq!(cp.utf8_bytes(5).unwrap(), mutf8_encode("玩家渲染").as_slice());
        assert_eq!(cp.utf8_bytes(7).unwrap(), b"Armour"); // 名字未被碰
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(ClassPool::parse(b"not a class").is_err());
        assert!(ClassPool::parse(&[]).is_err());
        let mut bad = sample_class();
        bad[8] = 0; // constant_pool_count = 0
        bad[9] = 0;
        assert!(ClassPool::parse(&bad).is_err());
        // 截断 → 必须报错而不是静默读半截
        let short = sample_class();
        assert!(ClassPool::parse(&short[..20]).is_err());
    }

    /// ── 真实第三方 class 的交叉验证（默认跳过）────────────────────────────────
    ///
    /// 合成夹具能覆盖"我知道的坑"，覆盖不了"真实字节码里还有别的花样"。
    /// 所以留一个按环境变量触发的探针，拿真 jar 跑一遍：
    ///
    /// ```text
    /// MCL_CLASS_PROBE=D:\下载\hiddenarmour-2.3.0.jar \
    /// MCL_CLASS_PROBE_OUT=<输出目录> \
    ///   cargo test probes_real_classes -- --nocapture
    /// ```
    ///
    /// 它做三件事：
    /// 1. 逐个 class 解析 + 尾部遍历（等价于结构自检），打印 `pool/utf8/literals/safe` 计数
    ///    —— 这几个数会拿去和**独立实现**（Python 版 `cf.py`）对账；
    /// 2. 把每个"可安全改写"的字面量都试改一遍（追加一个汉字），复解析 + 尾部逐字节比对；
    /// 3. 设了 `MCL_CLASS_PROBE_OUT` 时把改写后的 class 写出去，交给 `javap` 做
    ///    第三方实现（JVM 自己的反汇编器）验证。
    #[test]
    fn probes_real_classes_when_requested() {
        let Ok(jar) = std::env::var("MCL_CLASS_PROBE") else {
            return; // 未设环境变量 → 静默跳过（常规 `cargo test` 不该依赖外部文件）
        };
        let out_dir = std::env::var("MCL_CLASS_PROBE_OUT").ok();
        // libtest 默认吞掉 println（`mcl.sh test` 又不透传 --nocapture），
        // 所以再落一份到文件，方便和独立实现逐行对账。
        let summary_path = std::env::var("MCL_CLASS_PROBE_SUMMARY").ok();
        let mut lines: Vec<String> = Vec::new();

        let f = std::fs::File::open(&jar).expect("无法打开探测 jar");
        let mut z = zip::ZipArchive::new(f).expect("不是 zip/jar");
        let (mut n_class, mut t_utf8, mut t_lit, mut t_safe, mut t_shadow) = (0usize, 0, 0, 0, 0);

        for i in 0..z.len() {
            let mut e = z.by_index(i).unwrap();
            let name = e.name().to_string();
            if !name.to_lowercase().ends_with(".class") {
                continue;
            }
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut e, &mut buf).unwrap();

            let cp = ClassPool::parse(&buf).expect("常量池解析失败");
            let names = cp.name_owned().expect("尾部遍历失败（结构自检）");
            let safe = cp.safe_literals().expect("安全字面量判定失败");
            let utf8n = scan_strings(&buf).len();
            let safen: usize = safe.values().map(|v| v.len()).sum();
            let lit: usize = (1..cp.count() as usize)
                .filter_map(|k| cp.slots[k])
                .filter(|s| s.tag == TAG_STRING)
                .count();

            n_class += 1;
            t_utf8 += utf8n;
            t_lit += lit;
            t_safe += safen;
            t_shadow += lit - safen;
            let line = format!(
                "CLASS {name} pool={} names={} utf8={utf8n} literals={lit} safe={safen} shadowed={}",
                cp.count(),
                names.len(),
                lit - safen
            );
            println!("{line}");
            lines.push(line);

            if safe.is_empty() {
                continue;
            }
            // 每个安全字面量都试改：追加一个汉字（长度必变，验证 u2 前缀重算）
            let mut ch: HashMap<u16, String> = HashMap::new();
            for (k, slots) in &safe {
                if k.len() > 60_000 {
                    continue;
                }
                let mut probe = String::from_utf8_lossy(k).into_owned();
                probe.push('中');
                for s in slots {
                    ch.insert(*s, probe.clone());
                }
            }
            let out = rewrite(&buf, &ch).expect("改写失败");
            let cp2 = ClassPool::parse(&out).expect("改写后无法解析");
            cp2.name_owned().expect("改写后尾部遍历失败");
            assert_eq!(
                &out[cp2.pool_end..],
                &buf[cp.pool_end..],
                "改写后尾部必须逐字节不变"
            );
            for (k, slots) in &safe {
                if k.len() > 60_000 {
                    continue;
                }
                let mut probe = String::from_utf8_lossy(k).into_owned();
                probe.push('中');
                let want = mutf8_encode(&probe);
                for s in slots {
                    assert_eq!(cp2.utf8_bytes(*s).unwrap(), want.as_slice());
                }
            }

            if let Some(dir) = &out_dir {
                std::fs::create_dir_all(dir).unwrap();
                let flat = name.replace('/', "__");
                std::fs::write(format!("{dir}/{flat}"), &out).unwrap();
            }
        }
        let total = format!(
            "TOTAL classes={n_class} utf8={t_utf8} literals={t_lit} safe={t_safe} shadowed={t_shadow}"
        );
        println!("{total}");
        lines.push(total);
        if let Some(p) = summary_path {
            if let Some(dir) = std::path::Path::new(&p).parent() {
                std::fs::create_dir_all(dir).ok();
            }
            std::fs::write(p, lines.join("\n") + "\n").unwrap();
        }
    }
}
