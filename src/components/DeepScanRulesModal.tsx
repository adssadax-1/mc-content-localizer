import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { ReloadOutlined, UploadOutlined, DownloadOutlined, ExperimentOutlined } from "@ant-design/icons";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { CustomRule, DeepScanRules, RuleMeta, RuleMetaItem } from "../types";
import { useTranslationContext } from "../i18n";
import { DeepScanIcon } from "./DeepScanIcon";

type Kind = "mod" | "plugin";

interface Props {
  open: boolean;
  kind: Kind;
  /** 当前生效规则（全局或单包覆盖后的结果） */
  rules: DeepScanRules;
  /** 自定义规则是否只读（单包场景：不允许新增/编辑） */
  customReadOnly?: boolean;
  /** 自定义规则的启用状态（单包场景直接改这里，不落全局设置） */
  customEnabled?: Record<string, boolean>;
  /** 测试台可用的目标包路径（单包场景传入该包） */
  previewTarget?: string | null;
  /** 全局规则（单包场景传入）：用于「跟随全局设置」一键清除本包覆盖 */
  globalRules?: DeepScanRules;
  onClose: () => void;
  /** 保存回调：始终回传完整规则与自定义规则启用状态，由调用方决定写入位置 */
  onSave: (next: {
    rules: DeepScanRules;
    customEnabled: Record<string, boolean>;
  }) => void;
  /** 作用域标识（全局为 mod/plugin；单包为 pack.key）——变化时才重新初始化，避免编辑被父组件重渲染清空 */
  scopeKey?: string;
}

const GROUP_ORDER: RuleMetaItem["group"][] = ["scope", "path", "filter"];

/** 内置规则布尔字段（与后端 DeepScanRules 一一对应） */
const DEEP_RULE_KEYS = [
  "scopeJson", "scopeLang", "scopeText", "scopeNested", "scopeClass",
  "skipMeta", "skipLangfiles", "skipLibs", "onlySourceLocale", "keepCjk",
  "dropSql", "dropDescriptor", "dropLog", "dropIdent", "classNeedsMarker",
] as const;

/** snake_case → camelCase（兼容历史元数据 id） */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * 深度扫描规则配置弹窗（模组 / 插件共用）：
 * 顶部总开关 → 模板与档案 → 内置规则分组（含说明与锁定项）→ 自定义规则 → 规则测试台。
 * 规则清单由后端元数据下发，前端不写死规则名。
 */
export function DeepScanRulesModal({
  open: isOpen,
  kind,
  rules: initialRules,
  customReadOnly,
  customEnabled: customEnabledProp,
  scopeKey,
  previewTarget,
  globalRules,
  onClose,
  onSave,
}: Props) {
  const { t } = useTranslationContext();
  const [meta, setMeta] = useState<RuleMeta | null>(null);
  const [rules, setRules] = useState<DeepScanRules>(initialRules);
  const [editing, setEditing] = useState<CustomRule | null>(null);
  const isPlugin = kind === "plugin";
  // 三套模板（打开时预取，用于高亮「当前生效模板」与判断是否已自定义）
  const [templates, setTemplates] = useState<Record<string, DeepScanRules>>({});
  // 自定义规则的启用状态（单包场景只允许改这里，不落全局设置）
  const [customEnabled, setCustomEnabled] = useState<Record<string, boolean>>(customEnabledProp ?? {});
  // 打开瞬间的入参快照（避免依赖可变对象导致的编辑被重置）
  const initialRulesRef = useRef(initialRules);
  const customEnabledRef = useRef(customEnabledProp);
  if (!isOpen) {
    initialRulesRef.current = initialRules;
    customEnabledRef.current = customEnabledProp;
  }

  // 仅在「打开」或「切换作用域」时初始化本地状态。
  // 注意：不能依赖 initialRules —— 父组件每次渲染都会新建该对象，
  // 否则弹窗打开期间任何父级重渲染都会清空用户正在修改的内容。
  const scope = scopeKey ?? kind;
  useEffect(() => {
    if (!isOpen) return;
    setRules(initialRulesRef.current);
    setCustomEnabled(customEnabledRef.current ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scope]);

  useEffect(() => {
    if (!isOpen || meta) return;
    api
      .deepScanRuleMeta()
      .then(setMeta)
      .catch(() => message.error(t("settings.deepScan.metaFailed")));
  }, [isOpen, meta, t]);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    void (async () => {
      const names = ["recommended", "lite", "full"];
      const out: Record<string, DeepScanRules> = {};
      for (const n of names) {
        try {
          out[n] = await api.deepScanTemplate(n, isPlugin);
        } catch {
          /* 单个模板拉取失败不影响使用 */
        }
      }
      if (alive) setTemplates(out);
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, isPlugin]);

  /** 当前规则与哪个模板一致（都不同则为 null = 已自定义） */
  const activeTemplate = useMemo(
    () =>
      Object.entries(templates).find(([, tpl]) =>
        DEEP_RULE_KEYS.every((k) => tpl[k] === rules[k]),
      )?.[0] ?? null,
    [templates, rules],
  );

  const setFlag = useCallback((id: string, value: boolean) => {
    setRules((prev) => ({ ...prev, [id]: value }));
  }, []);

  const locked = useMemo(() => new Set((meta?.rules ?? []).filter((r) => r.locked).map((r) => r.id)), [meta]);

  const enabledBuiltin = useMemo(() => {
    let n = 0;
    for (const r of meta?.rules ?? []) if ((rules as unknown as Record<string, boolean>)[r.id]) n += 1;
    return n;
  }, [meta, rules]);

  // ── 模板：内容以后端为准（避免前后端模板定义漂移），保留用户自定义规则 ──
  const applyTemplate = useCallback(
    async (name: string) => {
      try {
        const tpl = await api.deepScanTemplate(name, isPlugin);
        setRules((prev) => ({ ...tpl, auto: prev.auto, custom: prev.custom }));
      } catch (e) {
        message.error(String(e));
      }
    },
    [isPlugin],
  );

  // ── 档案导入 / 导出 ──
  const exportProfile = async () => {
    try {
      const json = await api.deepScanProfileExport(
        kind,
        `${isPlugin ? "plugin" : "mod"}-rules`,
        null,
        rules,
      );
      const target = await save({
        defaultPath: `${isPlugin ? "plugin" : "mod"}-deepscan-rules.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!target) return;
      await api.writeTextFile(target, json);
      message.success(t("settings.deepScan.profileExported"));
    } catch (e) {
      message.error(String(e));
    }
  };

  const importProfile = async () => {
    try {
      const picked = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!picked || typeof picked !== "string") return;
      const content = await api.readTextFileLimited(picked);
      const { profile, warnings } = await api.deepScanProfileValidate(content, kind);
      // 档案里的自定义规则追加到现有列表（同 id 覆盖），内置规则整体套用
      setRules((prev) => {
        const merged = new Map(prev.custom.map((r) => [r.id, r]));
        for (const r of profile.rules.custom) merged.set(r.id, r);
        return { ...profile.rules, auto: prev.auto, custom: [...merged.values()] };
      });
      if (warnings.length > 0) message.warning(warnings.join("；"), 6);
      message.success(t("settings.deepScan.profileImported", { name: profile.name }));
    } catch (e) {
      message.error(String(e));
    }
  };

  // ── 自定义规则编辑 ──
  const saveRule = () => {
    if (!editing) return;
    const r = editing;
    if (!r.name.trim() || !r.pattern.trim()) {
      message.warning(t("settings.deepScan.ruleIncomplete"));
      return;
    }
    setRules((prev) => {
      const list = prev.custom.filter((x) => x.id !== r.id);
      return { ...prev, custom: [...list, r] };
    });
    setEditing(null);
  };

  const removeRule = (id: string) => {
    setRules((prev) => ({ ...prev, custom: prev.custom.filter((r) => r.id !== id) }));
  };

  return (
    <Modal
      title={
        <Space size={6}>
          <DeepScanIcon size={15} />
          <span>{t(isPlugin ? "settings.deepScan.titlePlugin" : "settings.deepScan.titleMod")}</span>
        </Space>
      }
      open={isOpen}
      onCancel={onClose}
      width={860}
      footer={[
        // 单包场景下「恢复默认」应指回到全局规则（否则用户无法取消本包覆盖），
        // 全局场景则回到推荐模板。
        <Button
          key="reset"
          icon={<ReloadOutlined />}
          onClick={() => {
            if (customReadOnly && globalRules) {
              setRules({ ...globalRules });
              setCustomEnabled({});
            } else {
              void applyTemplate("recommended");
            }
          }}
        >
          {t(
            customReadOnly && globalRules
              ? "settings.deepScan.followGlobal"
              : "settings.deepScan.restore",
          )}
        </Button>,
        <Button key="cancel" onClick={onClose}>
          {t("settings.deepScan.cancel")}
        </Button>,
        <Button
          key="ok"
          type="primary"
          onClick={() =>
            // 关键：单包场景也必须回传 rules，否则用户改的规则会被丢掉
            // （调用方决定持久化位置：全局写设置文件，单包只写内存里的包覆盖）
            onSave({
              rules: {
                ...rules,
                custom: rules.custom.map((r) => ({ ...r, enabled: customEnabled[r.id] ?? r.enabled })),
              },
              customEnabled,
            })
          }
        >
          {t("settings.deepScan.save")}
        </Button>,
      ]}
    >
      {/* 总开关：属全局设置；单包场景（customReadOnly）不显示，改为说明 */}
      {customReadOnly ? (
        <Alert
          type="info"
          showIcon
          message={t("settings.deepScan.packScopeHint")}
          style={{ marginBottom: 8 }}
        />
      ) : (
        <Space style={{ marginBottom: 8 }} align="center">
          <Switch checked={rules.auto} onChange={(v) => setRules((p) => ({ ...p, auto: v }))} />
          <Typography.Text strong>
            {t(isPlugin ? "settings.deepScan.autoPlugin" : "settings.deepScan.autoMod")}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("settings.deepScan.autoHint")}
          </Typography.Text>
        </Space>
      )}

      <Divider style={{ margin: "8px 0" }} />

      {/* 模板与档案 */}
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t("settings.deepScan.template")}
        </Typography.Text>
        <Button
          size="small"
          type={activeTemplate === "recommended" ? "primary" : "default"}
          onClick={() => void applyTemplate("recommended")}
        >
          {t("settings.deepScan.tplRecommended")}
        </Button>
        <Button
          size="small"
          type={activeTemplate === "lite" ? "primary" : "default"}
          onClick={() => void applyTemplate("lite")}
        >
          {t("settings.deepScan.tplLite")}
        </Button>
        <Button
          size="small"
          type={activeTemplate === "full" ? "primary" : "default"}
          onClick={() => void applyTemplate("full")}
        >
          {t("settings.deepScan.tplFull")}
        </Button>
        <Tag color={activeTemplate ? "blue" : "orange"}>
          {activeTemplate
            ? t("settings.deepScan.activeTemplate", {
                name: t(
                  activeTemplate === "recommended"
                    ? "settings.deepScan.tplRecommended"
                    : activeTemplate === "lite"
                      ? "settings.deepScan.tplLite"
                      : "settings.deepScan.tplFull",
                ),
              })
            : t("settings.deepScan.customized")}
        </Tag>
        <Divider type="vertical" />
        <Button size="small" icon={<UploadOutlined />} onClick={() => void importProfile()}>
          {t("settings.deepScan.importProfile")}
        </Button>
        <Button size="small" icon={<DownloadOutlined />} onClick={() => void exportProfile()}>
          {t("settings.deepScan.exportProfile")}
        </Button>
        <Tag color="blue">
          {t("settings.deepScan.enabledCount", { n: enabledBuiltin, total: meta?.rules.length ?? 0 })}
        </Tag>
      </Space>

      <Tabs
        items={[
          {
            key: "rules",
            label: t("settings.deepScan.tabRules"),
            children: (
              <div style={{ maxHeight: "46vh", overflowY: "auto", paddingRight: 4 }}>
                {GROUP_ORDER.map((group) => (
                  <div key={group} style={{ marginBottom: 12 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {t(`settings.deepScan.group.${group}`)}
                    </Typography.Text>
                    {(meta?.rules ?? [])
                      .filter((r) => r.group === group)
                      .map((r) => {
                        const isLocked = locked.has(r.id);
                        // 元数据 id 现为 camelCase（与规则字段一致）；同时兼容历史 snake_case
                        const field = r.id.includes("_") ? snakeToCamel(r.id) : r.id;
                        const checked = (rules as unknown as Record<string, boolean>)[field];
                        return (
                          <div
                            key={r.id}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              padding: "6px 0",
                              borderBottom: "1px solid var(--border-color, #F0F2F5)",
                            }}
                          >
                            <Switch
                              size="small"
                              checked={checked}
                              disabled={isLocked}
                              onChange={(v) => setFlag(field, v)}
                              style={{ marginTop: 3 }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Space size={6}>
                                <Typography.Text style={{ fontSize: 13 }}>
                                  {t(`settings.deepScan.rule.${r.key}`)}
                                </Typography.Text>
                                {isLocked && <Tag color="default">{t("settings.deepScan.locked")}</Tag>}
                                {r.defaultMod !== r.defaultPlugin && (
                                  <Tag color={isPlugin ? "purple" : "blue"}>
                                    {t(isPlugin ? "settings.deepScan.defaultOnPlugin" : "settings.deepScan.defaultOnMod")}
                                  </Tag>
                                )}
                              </Space>
                              <Typography.Text
                                type="secondary"
                                style={{ fontSize: 12, display: "block", lineHeight: 1.5 }}
                              >
                                {t(`settings.deepScan.desc.${r.key}`)}
                              </Typography.Text>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t("settings.deepScan.fixedNote")}
                </Typography.Text>
              </div>
            ),
          },
          {
            key: "custom",
            label: t("settings.deepScan.tabCustom", { n: rules.custom.length }),
            children: (
              <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
                {customReadOnly && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 8 }}
                    message={t("settings.deepScan.customReadOnly")}
                  />
                )}
                {rules.custom.length === 0 && (
                  <Typography.Text type="secondary">{t("settings.deepScan.customEmpty")}</Typography.Text>
                )}
                {rules.custom.map((r) => (
                  <div
                    key={r.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}
                  >
                    <Checkbox
                      checked={customEnabled[r.id] ?? r.enabled}
                      onChange={(e) =>
                        setCustomEnabled((prev) => ({ ...prev, [r.id]: e.target.checked }))
                      }
                    />
                    <Tag color={r.source === "imported" ? "geekblue" : "green"}>
                      {t(`settings.deepScan.kind.${r.kind}`)}
                    </Tag>
                    <Typography.Text style={{ fontSize: 13 }}>{r.name}</Typography.Text>
                    <Typography.Text code style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
                      {r.pattern}
                    </Typography.Text>
                    <Tag>{r.action === "include" ? t("settings.deepScan.actInclude") : t("settings.deepScan.actExclude")}</Tag>
                    <Button
                      size="small"
                      disabled={customReadOnly}
                      onClick={() => setEditing({ ...r })}
                    >
                      {t("settings.deepScan.edit")}
                    </Button>
                    <Button size="small" danger disabled={customReadOnly} onClick={() => removeRule(r.id)}>
                      {t("settings.deepScan.remove")}
                    </Button>
                  </div>
                ))}
                <Divider style={{ margin: "10px 0" }} />
                <RuleForm
                  rule={editing}
                  maxLen={meta?.maxPatternLen ?? 200}
                  onChange={setEditing}
                  onSave={saveRule}
                  disabled={customReadOnly}
                />
              </div>
            ),
          },
          {
            key: "testbed",
            label: t("settings.deepScan.tabTest"),
            children: <RuleTestbed kind={kind} rules={rules} target={previewTarget ?? null} />,
          },
        ]}
      />
    </Modal>
  );
}

/** 自定义规则表单 */
function RuleForm({
  rule,
  maxLen,
  onChange,
  onSave,
  disabled,
}: {
  rule: CustomRule | null;
  maxLen: number;
  onChange: (r: CustomRule | null) => void;
  onSave: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslationContext();
  if (disabled) return null;
  if (!rule) {
    return (
      <Button
        onClick={() =>
          onChange({
            id: `u${Date.now()}`,
            name: "",
            enabled: true,
            kind: "textRegex",
            pattern: "",
            action: "exclude",
            source: "user",
          })
        }
      >
        {t("settings.deepScan.addRule")}
      </Button>
    );
  }
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={6}>
      <Space wrap>
        <Input
          size="small"
          style={{ width: 160 }}
          placeholder={t("settings.deepScan.ruleName")}
          value={rule.name}
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
        />
        <Select
          size="small"
          style={{ width: 130 }}
          value={rule.kind}
          onChange={(v) => onChange({ ...rule, kind: v })}
          options={(["ext", "fileGlob", "pathGlob", "textRegex"] as const).map((k) => ({
            value: k,
            label: t(`settings.deepScan.kind.${k}`),
          }))}
        />
        <Radio.Group
          size="small"
          value={rule.action}
          onChange={(e) => onChange({ ...rule, action: e.target.value })}
        >
          <Radio.Button value="include">{t("settings.deepScan.actInclude")}</Radio.Button>
          <Radio.Button value="exclude">{t("settings.deepScan.actExclude")}</Radio.Button>
        </Radio.Group>
      </Space>
      <Input
        size="small"
        maxLength={maxLen}
        placeholder={t(`settings.deepScan.ph.${rule.kind}`)}
        value={rule.pattern}
        onChange={(e) => onChange({ ...rule, pattern: e.target.value })}
      />
      <Space>
        <Button size="small" type="primary" onClick={onSave}>
          {t("settings.deepScan.saveRule")}
        </Button>
        <Button size="small" onClick={() => onChange(null)}>
          {t("settings.deepScan.cancel")}
        </Button>
      </Space>
    </Space>
  );
}

/** 规则测试台：对一个包按当前规则预览扫描结果 */
function RuleTestbed({
  kind,
  rules,
  target,
}: {
  kind: Kind;
  rules: DeepScanRules;
  target: string | null;
}) {
  const { t } = useTranslationContext();
  const [path, setPath] = useState<string | null>(target);
  const [preview, setPreview] = useState<{
    total: number;
    groups: { key: string; label: string; count: number; defaultChecked: boolean }[];
    samples: { source: string; filePath: string; group: string }[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setPath(target), [target]);

  const run = useCallback(
    async (p: string) => {
      setLoading(true);
      try {
        const res = await api.deepScanPreview(p, rules);
        setPreview(res);
      } catch (e) {
        message.error(String(e));
      } finally {
        setLoading(false);
      }
    },
    [rules],
  );

  // 规则或目标变化后 400ms 重跑（避免拖动开关时频繁扫描）
  useEffect(() => {
    if (!path) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(path), 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [path, run]);

  const pick = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: kind === "plugin" ? "Plugin" : "Mod", extensions: ["jar", "zip"] }],
    });
    if (picked && typeof picked === "string") setPath(picked);
  };

  return (
    <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
      <Space style={{ marginBottom: 8 }} wrap>
        <Button size="small" icon={<ExperimentOutlined />} onClick={() => void pick()}>
          {t("settings.deepScan.testPick")}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
          {path ?? t("settings.deepScan.testNoTarget")}
        </Typography.Text>
        {preview && (
          <Tag color="green">{t("settings.deepScan.testTotal", { n: preview.total })}</Tag>
        )}
      </Space>
      {preview && (
        <>
          <Space wrap style={{ marginBottom: 8 }}>
            {preview.groups.map((g) => (
              <Tag key={g.key} color={g.defaultChecked ? "green" : "default"}>
                {g.label} {g.count}
                {g.defaultChecked ? " ✓" : ""}
              </Tag>
            ))}
          </Space>
          <Table
            size="small"
            rowKey={(r) => `${r.source}|${r.filePath}`}
            dataSource={preview.samples}
            pagination={false}
            columns={[
              { title: t("settings.deepScan.colText"), dataIndex: "source", ellipsis: true },
              { title: t("settings.deepScan.colGroup"), dataIndex: "group", width: 160 },
              { title: t("settings.deepScan.colFile"), dataIndex: "filePath", width: 220, ellipsis: true },
            ]}
          />
        </>
      )}
      {!preview && !loading && (
        <Typography.Text type="secondary">{t("settings.deepScan.testHint")}</Typography.Text>
      )}
      {loading && <Typography.Text type="secondary">{t("settings.deepScan.testRunning")}</Typography.Text>}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        <Tooltip title={t("settings.deepScan.testNoteTip")}>
          <span>{t("settings.deepScan.testNote")}</span>
        </Tooltip>
      </Typography.Paragraph>
    </div>
  );
}
