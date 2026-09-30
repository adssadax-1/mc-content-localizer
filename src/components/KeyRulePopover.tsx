import { useMemo, useState, type ReactNode } from "react";
import { Button, Popover, Tag, Tooltip, Typography, message } from "antd";
import { useTranslationContext } from "../i18n";
import type { CustomRule, LangEntry } from "../types";
import { RuleForm } from "./DeepScanRulesModal";

/** Key 悬浮快捷规则的工具集（App 按 activeTab 组装，仅 mod/plugin 启用） */
export interface KeyRuleTools {
  rules: CustomRule[];
  maxPatternLen: number;
  onCreate: (rule: CustomRule) => void;
  onUpdate: (rule: CustomRule) => void;
  onDelete: (id: string) => void;
  onViewAll: () => void;
}

interface Props {
  entry: LangEntry;
  tools: KeyRuleTools;
  children: ReactNode;
}

/** 一个可生成的范围：层级由当前路径动态推导，不写死级数 */
interface Scope {
  labelKey: string;
  pattern: string;
}

/** 自定义规则的引擎语义：exclude 恒优先（scan_rules 的 file_excluded 先于 path_allowed）。
 *  因此当某范围的任一祖先目录已被排除规则覆盖时，「包含」不会生效，直接禁用并说明。 */
function blockedByExclude(scopes: Scope[], idx: number, rules: CustomRule[]): boolean {
  const scope = scopes[idx];
  return rules.some(
    (r) =>
      r.enabled &&
      r.kind === "pathGlob" &&
      r.action === "exclude" &&
      r.pattern.toLowerCase().endsWith("/**") &&
      scope.pattern.startsWith(r.pattern.slice(0, -2)),
  );
}

/**
 * Key 悬浮快捷规则 Popover：根据条目的 filePath 动态给出「当前文件 / 当前目录 /
 * 上一级 / 上两级」的包含·排除快捷按钮，直接读写现有的自定义深度扫描规则
 * （settings.deepScanRules.{mod,plugin}.custom，经 patchSettings 保存）。
 * 不拦截点击 —— 包裹的 key 单元格点击行为（打开详情 Drawer）保持原样。
 */
export function KeyRulePopover({ entry, tools, children }: Props) {
  const { t } = useTranslationContext();
  const [editing, setEditing] = useState<CustomRule | null>(null);
  const path = (entry.filePath ?? "").trim();

  /** 路径 → 候选范围。层级按真实路径推导：没有父目录就只有「当前文件」。 */
  const scopes = useMemo<Scope[]>(() => {
    if (!path) return [];
    const out: Scope[] = [{ labelKey: "app.ruleScopeFile", pattern: path.toLowerCase() }];
    const dirEnd = path.lastIndexOf("/");
    if (dirEnd <= 0) return out; // 根级文件：不提供「根目录 **」全量规则，防止一键放行整包
    const dir = path.slice(0, dirEnd).toLowerCase();
    out.push({ labelKey: "app.ruleScopeDir", pattern: `${dir}/**` });
    const segs = dir.split("/");
    for (let up = 1; up <= 2 && segs.length - up >= 1; up++) {
      const pat = `${segs.slice(0, segs.length - up).join("/")}/**`;
      out.push({ labelKey: up === 1 ? "app.ruleScopeParent" : "app.ruleScopeGrand", pattern: pat });
    }
    return out.filter((s) => s.pattern.length <= tools.maxPatternLen);
  }, [path, tools.maxPatternLen]);

  /** 与该路径相关的已启用 pathGlob 规则：
   *  精确等于候选 pattern，或「dir/**」且路径命中其前缀。只识别这两种形态
   *  （即本 Popover 自己会产生的那种），其它通配请走「查看全部规则」。 */
  const related = useMemo(() => {
    const lower = path.toLowerCase();
    return tools.rules.filter((r) => {
      if (!r.enabled || r.kind !== "pathGlob") return false;
      const p = r.pattern.toLowerCase();
      if (p === lower) return true;
      return p.endsWith("/**") && lower.startsWith(`${p.slice(0, -3)}/`);
    });
  }, [tools.rules, path]);

  /** 同 pattern 的既有规则（不论启用与否）——存在即不重复创建 */
  const findSame = (pattern: string, action: CustomRule["action"]) =>
    tools.rules.find(
      (r) => r.kind === "pathGlob" && r.action === action && r.pattern.toLowerCase() === pattern,
    );

  const makeRule = (scope: Scope, action: CustomRule["action"]): CustomRule => ({
    id: `u${Date.now()}`,
    name: `${t(action === "exclude" ? "settings.deepScan.actExclude" : "settings.deepScan.actInclude")} ${scope.pattern}`.slice(0, 40),
    enabled: true,
    kind: "pathGlob",
    pattern: scope.pattern,
    action,
    source: "user",
  });

  const create = (scope: Scope, action: CustomRule["action"]) => {
    if (findSame(scope.pattern, action)) {
      message.info(t("app.ruleDup"));
      return;
    }
    if (tools.rules.length >= 20) {
      message.warning(t("app.ruleLimit"));
      return;
    }
    tools.onCreate(makeRule(scope, action));
  };

  /** 编辑态行：复用 DeepScanRulesModal 的 RuleForm（同一套校验与字段） */
  const editor = editing ? (
    <div style={{ borderTop: "1px solid var(--border-color, #F0F2F5)", marginTop: 8, paddingTop: 8 }}>
      <RuleForm
        rule={editing}
        maxLen={tools.maxPatternLen}
        onChange={setEditing}
        onSave={() => {
          if (!editing.name.trim() || !editing.pattern.trim()) {
            message.warning(t("settings.deepScan.ruleIncomplete"));
            return;
          }
          tools.onUpdate(editing);
          setEditing(null);
          message.success(t("app.ruleSaved"));
        }}
      />
    </div>
  ) : null;

  const content = (
    <div style={{ width: 420 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("app.ruleSourceFile")}
      </Typography.Text>
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        <Typography.Text code copyable={{ text: path }} style={{ fontSize: 12, wordBreak: "break-all" }}>
          {path || "—"}
        </Typography.Text>
      </Typography.Paragraph>

      {scopes.map((sc, i) => {
        const rows = [false, true].map((isExclude) => {
          const action: CustomRule["action"] = isExclude ? "exclude" : "include";
          const same = findSame(sc.pattern, action);
          const blocked = !isExclude && blockedByExclude(scopes, i, tools.rules);
          if (same) {
            return (
              <Tag key={action} color={isExclude ? "volcano" : "green"}>
                {t(isExclude ? "settings.deepScan.actExclude" : "settings.deepScan.actInclude")}
                {!same.enabled && (
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 2 }}>
                    ({t("app.ruleDisabled")})
                  </Typography.Text>
                )}
                <Button
                  type="link"
                  size="small"
                  style={{ padding: "0 4px" }}
                  onClick={() => setEditing({ ...same })}
                >
                  {t("settings.deepScan.edit")}
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger
                  style={{ padding: "0 4px" }}
                  onClick={() => {
                    tools.onDelete(same.id);
                    message.success(t("app.ruleDeleted"));
                  }}
                >
                  {t("settings.deepScan.remove")}
                </Button>
              </Tag>
            );
          }
          return (
            <TooltipIf
              key={action}
              show={blocked}
              text={t("app.ruleBlockedByExclude")}
            >
              <Button
                size="small"
                disabled={blocked}
                onClick={() => create(sc, action)}
              >
                {t(isExclude ? "app.ruleExcludeScope" : "app.ruleIncludeScope", {
                  scope: t(sc.labelKey),
                })}
              </Button>
            </TooltipIf>
          );
        });
        return (
          <div key={sc.pattern} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, width: 88 }}>
              {t(sc.labelKey)}
            </Typography.Text>
            {rows}
          </div>
        );
      })}

      {related.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border-color, #F0F2F5)", marginTop: 8, paddingTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("app.ruleExisting")}
          </Typography.Text>
          {related.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <Tag color={r.action === "exclude" ? "volcano" : "green"}>
                {t(r.action === "exclude" ? "settings.deepScan.actExclude" : "settings.deepScan.actInclude")}
                {!r.enabled && (
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 2 }}>
                    ({t("app.ruleDisabled")})
                  </Typography.Text>
                )}
              </Tag>
              <Typography.Text code style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
                {r.pattern}
              </Typography.Text>
              <Button type="link" size="small" style={{ padding: "0 4px" }} onClick={() => setEditing({ ...r })}>
                {t("settings.deepScan.edit")}
              </Button>
              <Button
                type="link"
                size="small"
                danger
                style={{ padding: "0 4px" }}
                onClick={() => {
                  tools.onDelete(r.id);
                  message.success(t("app.ruleDeleted"));
                }}
              >
                {t("settings.deepScan.remove")}
              </Button>
            </div>
          ))}
        </div>
      )}

      {editor}

      <div style={{ marginTop: 8 }}>
        <Button type="link" size="small" style={{ padding: 0 }} onClick={tools.onViewAll}>
          {t("app.ruleViewAll")}
        </Button>
      </div>
    </div>
  );

  // 无源路径的条目（不应出现，防御兜底）不提供规则入口，key 原样展示
  if (!path) return <>{children}</>;
  return (
    <Popover
      trigger="hover"
      placement="right"
      mouseEnterDelay={0.35}
      mouseLeaveDelay={0.15}
      title={t("app.ruleQuick")}
      content={content}
    >
      {children}
    </Popover>
  );
}

/** 仅在 show 时包 Tooltip 的极简包装（antd Tooltip 不接受条件渲染 children） */
function TooltipIf({ show, text, children }: { show: boolean; text: string; children: ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <Tooltip title={text}>
      <span>{children}</span>
    </Tooltip>
  );
}
