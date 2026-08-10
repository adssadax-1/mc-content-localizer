import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  InputNumber,
  Layout,
  message,
  Modal,
  Progress,
  Radio,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CloudUploadOutlined,
  ClearOutlined,
  DeleteOutlined,
  DownOutlined,
  ExportOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  RightOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";

import { api, onFileDropped, onGlossaryDone, onTranslateProgress } from "./api";
import { DropZone } from "./components/DropZone";
import { EntryTable } from "./components/EntryTable";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
import { LOADER_LABEL, packFormatForMc } from "./types";
import type {
  BatchItem,
  ModFile,
  ProgressPayload,
  ResourcePackBundle,
  Settings,
  TranslateContext,
} from "./types";

const { Header, Content, Footer } = Layout;

/** 队列中的单个模组 */
interface QueueItem {
  key: string;
  modFile: ModFile;
  jarPath: string;
  expanded: boolean;
  checked: boolean;
  /** 展开区域的显示高度（可拖动调节） */
  height: number;
}

function App() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [currentModName, setCurrentModName] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [packMode, setPackMode] = useState<"auto" | "custom">("auto");
  const [customPackFormat, setCustomPackFormat] = useState(15);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [paused, setPaused] = useState(false);

  // 初始化：加载设置
  useEffect(() => {
    api.loadSettings().then(setSettings).catch(() => setSettings(null));
  }, []);

  // 监听拖入文件
  useEffect(() => {
    const unlisten = onFileDropped((paths) => {
      void addFiles(paths);
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // 全窗口拖放高亮
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // 监听翻译进度
  useEffect(() => {
    const unlisten = onTranslateProgress((p) => setProgress(p));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  useEffect(() => {
    const unlisten = onGlossaryDone((count) => {
      if (count > 0) message.info(`已提取 ${count} 条术语，用于统一译名`);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /** 打开文件选择（点击中央区域） */
  async function pickFiles() {
    const paths = await open({
      multiple: true,
      title: "选择模组 jar 文件（可多选）",
      filters: [{ name: "Minecraft 模组", extensions: ["jar", "zip"] }],
    });
    if (paths && paths.length > 0) {
      await addFiles(paths);
    }
  }

  /** 导入 jar 到队列 */
  async function addFiles(paths: string[]) {
    const jars = paths.filter(
      (p) => p.toLowerCase().endsWith(".jar") || p.toLowerCase().endsWith(".zip"),
    );
    if (jars.length === 0) {
      message.error("请选择 .jar 或 .zip 文件");
      return;
    }
    setParsing(true);
    const added: QueueItem[] = [];
    let zhHits = 0;
    let zhTotal = 0;
    for (const p of jars) {
      try {
        const mf = await api.parseJar(p);
        const item: QueueItem = {
          key: `${mf.fileName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          modFile: mf,
          jarPath: p,
          expanded: true,
          checked: true,
          height: 320,
        };
        added.push(item);
        if (mf.hasZh) {
          zhHits += 1;
          zhTotal += mf.zhCount ?? 0;
        }
      } catch (e) {
        message.error(`「${p.split(/[\\/]/).pop()}」解析失败：${String(e)}`);
      }
    }
    setQueue((prev) => [...prev, ...added]);
    setParsing(false);
    if (added.length > 0) {
      message.success(`已导入 ${added.length} 个模组`);
    }
    // 检测到自带中文：提示是否继续汉化未翻译部分
    if (zhHits > 0) {
      Modal.confirm({
        title: "检测到模组自带中文",
        content: `${zhHits} 个模组自带中文（共 ${zhTotal} 条），已自动填入对应译文。是否继续汉化其中未翻译的部分？`,
        okText: "继续汉化",
        cancelText: "暂不",
        onOk: () => void runTranslation(),
      });
    }
  }

  /** 更新某个模组的条目 */
  function patchMod(key: string, fn: (mf: ModFile) => ModFile) {
    setQueue((prev) =>
      prev.map((it) =>
        it.key === key ? { ...it, modFile: fn(it.modFile) } : it,
      ),
    );
  }

  function editTranslation(modKey: string, entryKey: string, value: string) {
    patchMod(modKey, (mf) => ({
      ...mf,
      entries: mf.entries.map((e) => {
        if (e.key !== entryKey) return e;
        const trimmed = value.trim();
        if (trimmed === "") {
          return { ...e, translation: null, status: "untranslated" as const };
        }
        return { ...e, translation: value, status: "userConfirmed" as const };
      }),
    }));
  }

  /** 单条清除译文：恢复未翻译，重新加入汉化队列 */
  function clearTranslation(modKey: string, entryKey: string) {
    patchMod(modKey, (mf) => ({
      ...mf,
      entries: mf.entries.map((e) =>
        e.key === entryKey
          ? { ...e, translation: null, status: "untranslated" as const, notes: [] }
          : e,
      ),
    }));
    message.info("已清除该条译文，下次翻译会重新加入队列");
  }

  function toggleChecked(key: string, checked: boolean) {
    setQueue((prev) => prev.map((it) => (it.key === key ? { ...it, checked } : it)));
  }

  function toggleAll(checked: boolean) {
    setQueue((prev) => prev.map((it) => ({ ...it, checked })));
  }

  function toggleExpanded(key: string) {
    setQueue((prev) => prev.map((it) => (it.key === key ? { ...it, expanded: !it.expanded } : it)));
  }

  /** 拖动调节某模组展开区高度（拖动过程直接改 DOM，避免频繁重渲染卡顿） */
  function startResize(key: string, e: React.MouseEvent) {
    e.preventDefault();
    // 拖动手柄的前一个兄弟元素 = 该模组的表格容器
    const handle = e.currentTarget as HTMLElement;
    const box = handle.previousElementSibling as HTMLElement | null;
    if (!box) return;
    const startY = e.clientY;
    const startH = box.offsetHeight;
    document.body.style.userSelect = "none";
    let raf = 0;
    const onMove = (ev: MouseEvent) => {
      const h = Math.min(
        Math.max(startH + (ev.clientY - startY), 120),
        window.innerHeight - 180,
      );
      cancelAnimationFrame(raf);
      // rAF 节流 + 直接改 DOM，不触发 React 重渲染
      raf = requestAnimationFrame(() => {
        box.style.height = `${h}px`;
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      // 拖动结束一次性提交高度
      const finalH = box.offsetHeight;
      setQueue((prev) =>
        prev.map((it) => (it.key === key ? { ...it, height: finalH } : it)),
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** 翻译勾选的模组（逐个串行，增量翻译：已有中文/译文自动跳过） */
  async function runTranslation() {
    if (!settings) return;
    const targets = queue.filter((it) => it.checked);
    if (targets.length === 0) {
      message.info("请先勾选要翻译的模组");
      return;
    }
    if (!settings.provider.apiKey) {
      message.warning("请先在设置中填写 API Key");
      setSettingsOpen(true);
      return;
    }
    const provider = {
      ...settings.provider,
      temperature:
        settings.provider.temperature == null
          ? 0.7
          : Math.round(settings.provider.temperature * 100) / 100,
    };

    setTranslating(true);
    setCancelRequested(false);
    setPaused(false);
    let doneAny = false;
    try {
      for (const item of targets) {
        setCurrentModName(item.modFile.modName);
        const untranslated = item.modFile.entries.filter((e) => !e.translation);
        if (untranslated.length === 0) {
          continue;
        }
        const items: BatchItem[] = untranslated.map((e) => ({
          key: e.key,
          source: e.source,
        }));
        const ctx: TranslateContext = {
          modName: item.modFile.modName,
          modid: item.modFile.modid,
          mcVersion: item.modFile.mcVersion,
          loader: LOADER_LABEL[item.modFile.loader],
          userGlossary: settings.userGlossary,
        };
        setProgress({
          batchIndex: 0,
          batchTotal: 0,
          doneCount: 0,
          totalCount: items.length,
        });
        const results = await api.runTranslation(
          provider,
          ctx,
          items,
          settings.batchSize,
          settings.extractGlossary,
        );
        const byKey = new Map(results.map((r) => [r.key, r]));
        patchMod(item.key, (mf) => ({
          ...mf,
          entries: mf.entries.map((e) => {
            const r = byKey.get(e.key);
            if (!r) return e;
            if (!r.translation) {
              return { ...e, notes: r.notes.length > 0 ? r.notes : ["翻译失败"] };
            }
            const hasWarning = r.notes.length > 0;
            return {
              ...e,
              translation: r.translation,
              notes: r.notes,
              status: hasWarning ? ("placeholderError" as const) : ("aiTranslated" as const),
            };
          }),
        }));
        const failed = results.filter((r) => !r.translation).length;
        if (failed > 0) {
          message.warning(`「${item.modFile.modName}」完成，${failed} 条失败/缺失`);
        }
        doneAny = true;
        if (cancelRequested) break;
      }
      if (cancelRequested) {
        message.info("已取消，已翻译部分已保留");
      } else if (doneAny) {
        message.success("翻译完成");
      } else {
        message.info("勾选的模组没有需要翻译的条目（可能已全部翻译）");
      }
    } catch (e) {
      message.error(`翻译失败：${String(e)}`);
    }
    setTranslating(false);
    setProgress(null);
    setCurrentModName("");
  }

  function handleCancel() {
    setCancelRequested(true);
    void api.cancelTranslation();
    message.info("正在停止…当前批次完成后结束");
  }

  function handlePause() {
    setPaused(true);
    void api.pauseTranslation();
    message.info("已暂停，当前批次完成后停止");
  }

  function handleResume() {
    setPaused(false);
    void api.resumeTranslation();
  }

  function handleClear() {
    Modal.confirm({
      title: "清除所有译文？",
      content: "全部模组的译文将恢复为未翻译状态（原文保留），此操作不可撤销。",
      okText: "清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        setQueue((prev) =>
          prev.map((it) => ({
            ...it,
            modFile: {
              ...it.modFile,
              entries: it.modFile.entries.map((e) => ({
                ...e,
                translation: null,
                status: "untranslated" as const,
                notes: [],
              })),
            },
          })),
        );
        message.success("已清除全部译文");
      },
    });
  }

  /** 清空整个模组列表（移除全部模组） */
  function handleClearQueue() {
    Modal.confirm({
      title: "清空模组列表？",
      content: "将移除全部模组及其译文（不影响已保存的设置），此操作不可撤销。",
      okText: "清空列表",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        setQueue([]);
        setSelectedKey(null);
        setProgress(null);
        setTranslating(false);
        message.success("已清空模组列表");
      },
    });
  }

  async function handleExportPack() {
    const checked = queue.filter((it) => it.checked);
    if (checked.length === 0) {
      message.info("请先勾选要导出的模组");
      return;
    }
    const detected = packFormatForMc(
      checked.map((c) => c.modFile.mcVersion).find((v) => v) ?? null,
    );
    setCustomPackFormat(detected ?? 15);
    setPackMode("auto");
    setExportSettingsOpen(true);
  }

  async function doExportPack() {
    const checked = queue.filter((it) => it.checked);
    if (checked.length === 0) return;
    const packFormat =
      packMode === "auto" ? (customPackFormat || 15) : customPackFormat;
    const dir = await open({
      directory: true,
      title: "选择导出目录（生成 mods_zh_cn.zip 合并资源包）",
    });
    if (!dir) return;
    const bundles: ResourcePackBundle[] = checked.map((it) => ({
      modid: it.modFile.modid,
      modName: it.modFile.modName,
      entries: it.modFile.entries,
      langFormat: it.modFile.langFormat,
    }));
    try {
      const path = await api.exportResourcePackMulti(dir, bundles, packFormat);
      message.success(`已导出合并汉化资源包（${checked.length} 个模组）：${path}`);
      setExportSettingsOpen(false);
      setExportOpen(false);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleExportJar() {
    const checked = queue.filter((it) => it.checked);
    if (checked.length === 0) {
      message.info("请先勾选要导出的模组");
      return;
    }
    const dir = await open({
      directory: true,
      title: `选择目录（将生成 ${checked.length} 个汉化 jar，不覆盖原文件）`,
    });
    if (!dir) return;
    let ok = 0;
    for (const it of checked) {
      const translated = it.modFile.entries.filter((e) => e.translation);
      if (translated.length === 0) {
        message.warning(`「${it.modFile.modName}」没有译文，跳过`);
        continue;
      }
      const dest = `${dir}/${it.modFile.modid}_zh_cn.jar`;
      try {
        await api.exportModJar(
          it.jarPath,
          dest,
          it.modFile.modid,
          translated,
          it.modFile.langFormat,
        );
        ok += 1;
      } catch (e) {
        message.error(`「${it.modFile.modName}」导出失败：${String(e)}`);
      }
    }
    if (ok > 0) {
      message.success(`已生成 ${ok} 个汉化 jar：${dir}`);
      setExportOpen(false);
    }
  }

  const selectedEntry = useMemo(() => {
    for (const it of queue) {
      const e = it.modFile.entries.find((x) => x.key === selectedKey);
      if (e) return e;
    }
    return null;
  }, [queue, selectedKey]);

  const allChecked =
    queue.length > 0 && queue.every((it) => it.checked);

  const progressPercent = progress
    ? Math.round((progress.doneCount / Math.max(1, progress.totalCount)) * 100)
    : 0;

  return (
    <Layout style={{ height: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingInline: 20,
        }}
      >
        <Space size="middle">
          <Typography.Title level={4} style={{ color: "#fff", margin: 0 }}>
            ⛏ 模组 AI 汉化工具
          </Typography.Title>
          {queue.length > 0 && (
            <Tag color="blue">{queue.length} 个模组</Tag>
          )}
        </Space>
        <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
          设置
        </Button>
      </Header>

      <Content style={{ padding: 12, overflow: "auto" }}>
        {queue.length === 0 ? (
          <DropZone dragOver={dragOver} parsing={parsing} onPick={() => void pickFiles()} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <Space style={{ marginBottom: 8 }} wrap>
              {translating ? (
                <>
                  <Button
                    icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />}
                    onClick={paused ? handleResume : handlePause}
                  >
                    {paused ? "继续翻译" : "暂停"}
                  </Button>
                  <Button danger icon={<StopOutlined />} onClick={handleCancel}>
                    取消翻译
                  </Button>
                </>
              ) : (
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  disabled={parsing}
                  onClick={() => void runTranslation()}
                >
                  开始 AI 翻译
                </Button>
              )}
              <Button icon={<ExportOutlined />} disabled={translating} onClick={() => setExportOpen(true)}>
                导出
              </Button>
              <Button
                danger
                icon={<ClearOutlined />}
                disabled={translating}
                onClick={handleClear}
              >
                清除译文
              </Button>
              <Button
                danger
                icon={<DeleteOutlined />}
                disabled={translating}
                onClick={handleClearQueue}
              >
                清空列表
              </Button>
              <Button icon={<CloudUploadOutlined />} disabled={translating} onClick={() => void pickFiles()}>
                导入模组
              </Button>
              <Checkbox
                checked={allChecked}
                indeterminate={queue.some((it) => it.checked) && !allChecked}
                onChange={(e) => toggleAll(e.target.checked)}
                disabled={translating}
              >
                全选
              </Checkbox>
            </Space>

            {translating && progress && (
              <Space style={{ marginBottom: 8 }} align="center">
                <Typography.Text type="secondary">
                  正在翻译：{currentModName}
                </Typography.Text>
                <Progress
                  percent={progressPercent}
                  size="small"
                  style={{ width: 320 }}
                  status={paused ? "active" : undefined}
                  format={() =>
                    paused
                      ? `已暂停 ${progress.doneCount}/${progress.totalCount}`
                      : `${progress.doneCount}/${progress.totalCount}`
                  }
                />
              </Space>
            )}

            {/* 模组队列 */}
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {queue.map((it) => {
                const total = it.modFile.entries.length;
                const translated = it.modFile.entries.filter((e) => e.translation).length;
                return (
                  <div
                    key={it.key}
                    style={{
                      border: "1px solid #f0f0f0",
                      borderRadius: 8,
                      marginBottom: 8,
                      background: "#fff",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        flexWrap: "wrap",
                      }}
                      onClick={() => toggleExpanded(it.key)}
                    >
                      <Checkbox
                        checked={it.checked}
                        disabled={translating}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => toggleChecked(it.key, e.target.checked)}
                      />
                      {it.expanded ? <DownOutlined /> : <RightOutlined />}
                      <Typography.Text strong>{it.modFile.modName}</Typography.Text>
                      <Tag>{it.modFile.modid}</Tag>
                      {it.modFile.version && <Tag>{it.modFile.version}</Tag>}
                      <Tag>{LOADER_LABEL[it.modFile.loader]}</Tag>
                      {it.modFile.hasZh && (
                        <Tag color="cyan">自带中文 {it.modFile.zhCount ?? 0} 条</Tag>
                      )}
                      <Typography.Text type="secondary" style={{ marginLeft: "auto" }}>
                        {translated}/{total} 条已翻译
                      </Typography.Text>
                    </div>
                    {it.expanded && (
                      <div style={{ padding: "0 12px 12px" }}>
                        <div
                          style={{
                            height: it.height,
                            overflow: "auto",
                            border: "1px solid #f0f0f0",
                            borderRadius: 6,
                            padding: 8,
                          }}
                        >
                          <EntryTable
                            entries={it.modFile.entries}
                            onEdit={(k, v) => editTranslation(it.key, k, v)}
                            onSelect={setSelectedKey}
                            onClear={(k) => clearTranslation(it.key, k)}
                          />
                        </div>
                        {/* 拖动条：调节本模组显示区域高度 */}
                        <div
                          onMouseDown={(e) => startResize(it.key, e)}
                          title="拖动调节显示区域高度"
                          style={{
                            height: 10,
                            cursor: "row-resize",
                            marginTop: 4,
                            borderRadius: 4,
                            background: "#f0f0f0",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            userSelect: "none",
                          }}
                        >
                          <span style={{ fontSize: 10, color: "#999", letterSpacing: 2 }}>
                            ⠿⠿⠿
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Content>

      <Footer style={{ padding: "6px 12px", textAlign: "center" }}>
        <Typography.Text type="secondary">
          点击中央区域或拖入 jar 导入模组 · 勾选要翻译/导出的模组 · 自带中文自动填入，未翻译部分可继续汉化
        </Typography.Text>
      </Footer>

      <Drawer
        title={selectedEntry ? `${selectedEntry.key}` : ""}
        open={!!selectedEntry}
        onClose={() => setSelectedKey(null)}
        width={420}
      >
        {selectedEntry && (
          <ContextPanel entry={selectedEntry} allEntries={queue.flatMap((q) => q.modFile.entries)} />
        )}
      </Drawer>

      <Modal
        title="导出"
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        footer={null}
        width={480}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Typography.Text type="secondary">
            将导出全部勾选的 {queue.filter((it) => it.checked).length} 个模组
          </Typography.Text>
          <Button
            block
            size="large"
            icon={<ExportOutlined />}
            onClick={() => void handleExportPack()}
          >
            导出合并汉化资源包（一个 .zip 管所有勾选模组）
          </Button>
          <Button
            block
            size="large"
            icon={<SaveOutlined />}
            disabled={queue.filter((it) => it.checked).length === 0}
            onClick={() => void handleExportJar()}
          >
            生成汉化后的模组 jar（每模组一个，不覆盖原文件）
          </Button>
        </Space>
      </Modal>

      <Modal
        title="导出资源包设置"
        open={exportSettingsOpen}
        onCancel={() => setExportSettingsOpen(false)}
        onOk={() => void doExportPack()}
        okText="选择目录并导出"
        width={440}
      >
        <Typography.Text type="secondary">
          资源包 pack_format（依据 Minecraft Wiki；1.21.9+ 自动使用 min_format/max_format）
        </Typography.Text>
        <Radio.Group
          value={packMode}
          onChange={(e) => setPackMode(e.target.value)}
          style={{ marginTop: 12, width: "100%" }}
        >
          <Radio value="auto" style={{ display: "block", marginBottom: 12 }}>
            自动匹配 MC 版本（检测到 {customPackFormat}）
          </Radio>
          <Radio value="custom" style={{ display: "block" }}>
            自定义：
            {packMode === "custom" && (
              <InputNumber
                style={{ width: 120, marginLeft: 8 }}
                min={1}
                max={200}
                value={customPackFormat}
                onChange={(v) => setCustomPackFormat(v ?? 15)}
              />
            )}
          </Radio>
        </Radio.Group>
      </Modal>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
      />
    </Layout>
  );
}

export default App;
