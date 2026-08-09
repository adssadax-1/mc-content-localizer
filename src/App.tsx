import { useEffect, useMemo, useState } from "react";
import {
  Button,
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
  ExportOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { open, save } from "@tauri-apps/plugin-dialog";

import { api, onFileDropped, onGlossaryDone, onTranslateProgress } from "./api";
import { DropZone } from "./components/DropZone";
import { EntryTable } from "./components/EntryTable";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
import { LOADER_LABEL, packFormatForMc } from "./types";
import type {
  BatchItem,
  LangEntry,
  ModFile,
  ProgressPayload,
  Settings,
  TranslateContext,
} from "./types";

const { Header, Content, Footer } = Layout;

function App() {
  const [modFile, setModFile] = useState<ModFile | null>(null);
  const [entries, setEntries] = useState<LangEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [jarPath, setJarPath] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [paused, setPaused] = useState(false);
  // 导出资源包的 pack_format 设置（点击「导出汉化资源包」时弹出）
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [packMode, setPackMode] = useState<"auto" | "custom">("auto");
  const [customPackFormat, setCustomPackFormat] = useState(15);

  // 初始化：加载设置
  useEffect(() => {
    api.loadSettings().then(setSettings).catch(() => setSettings(null));
  }, []);

  // 监听 Rust 转发的拖入文件事件
  useEffect(() => {
    const unlisten = onFileDropped((paths) => {
      void handleFiles(paths);
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // 全窗口拖放高亮（前端 UI 反馈）
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

  async function handleFiles(paths: string[]) {
    const jarPath = paths.find(
      (p) => p.toLowerCase().endsWith(".jar") || p.toLowerCase().endsWith(".zip"),
    );
    if (!jarPath) {
      message.error("请拖入 .jar 或 .zip 文件");
      return;
    }
    setParsing(true);
    try {
      const mf = await api.parseJar(jarPath);
      setModFile(mf);
      setJarPath(jarPath);
      setEntries(mf.entries);
      message.success(
        `解析成功：${mf.modName}（${mf.entries.length} 条待翻译）`,
      );
    } catch (e) {
      message.error(String(e));
    }
    setParsing(false);
  }

  function editTranslation(key: string, value: string) {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.key !== key) return e;
        const trimmed = value.trim();
        if (trimmed === "") {
          return { ...e, translation: null, status: "untranslated" as const };
        }
        return { ...e, translation: value, status: "userConfirmed" as const };
      }),
    );
  }

  async function runTranslation() {
    if (!modFile || !settings) return;
    const items: BatchItem[] = entries
      .filter((e) => !e.translation)
      .map((e) => ({ key: e.key, source: e.source }));
    if (items.length === 0) {
      message.info("没有待翻译条目（可清空译文后重译）");
      return;
    }
    if (!settings.provider.apiKey) {
      message.warning("请先在设置中填写 API Key");
      setSettingsOpen(true);
      return;
    }

    const ctx: TranslateContext = {
      modName: modFile.modName,
      modid: modFile.modid,
      mcVersion: modFile.mcVersion,
      loader: LOADER_LABEL[modFile.loader],
      userGlossary: settings.userGlossary,
    };

    setTranslating(true);
    setCancelRequested(false);
    setProgress({
      batchIndex: 0,
      batchTotal: 0,
      doneCount: 0,
      totalCount: items.length,
    });
    // 翻译前兜底：温度最多 2 位小数（智谱要求，防旧设置多位小数）
    const provider = {
      ...settings.provider,
      temperature:
        settings.provider.temperature == null
          ? 0.7
          : Math.round(settings.provider.temperature * 100) / 100,
    };
    try {
      const results = await api.runTranslation(
        provider,
        ctx,
        items,
        settings.batchSize,
        settings.extractGlossary,
      );
      const byKey = new Map(results.map((r) => [r.key, r]));
      setEntries((prev) =>
        prev.map((e) => {
          const r = byKey.get(e.key);
          if (!r) return e;
          if (!r.translation) {
            // 翻译失败/缺失：保持原状态，备注错误
            return {
              ...e,
              notes: r.notes.length > 0 ? r.notes : ["翻译失败"],
            };
          }
          const hasWarning = r.notes.length > 0;
          return {
            ...e,
            translation: r.translation,
            notes: r.notes,
            status: hasWarning ? ("placeholderError" as const) : ("aiTranslated" as const),
          };
        }),
      );
      const failed = results.filter((r) => !r.translation).length;
      if (cancelRequested) {
        message.info(`已取消，保留已翻译的 ${results.length} 条`);
      } else if (failed > 0) {
        message.warning(`翻译完成，${failed} 条失败/缺失（详见备注列）`);
      } else {
        message.success(`翻译完成，共 ${results.length} 条`);
      }
    } catch (e) {
      message.error(`翻译失败：${String(e)}`);
    }
    setTranslating(false);
    setProgress(null);
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
      content: "全部条目将恢复为未翻译状态（原文保留），此操作不可撤销。",
      okText: "清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        setEntries((prev) =>
          prev.map((e) => ({
            ...e,
            translation: null,
            status: "untranslated" as const,
            notes: [],
          })),
        );
        message.success("已清除全部译文");
      },
    });
  }

  async function handleExportPack() {
    if (!modFile) return;
    const translated = entries.filter((e) => e.translation);
    if (translated.length === 0) {
      message.info("还没有译文可导出");
      return;
    }
    // 先弹出 pack_format 设置，确定后再选目录导出
    const detected = packFormatForMc(modFile.mcVersion) ?? 15;
    setCustomPackFormat(detected);
    setPackMode("auto");
    setExportSettingsOpen(true);
  }

  async function doExportPack() {
    if (!modFile) return;
    const translated = entries.filter((e) => e.translation);
    if (translated.length === 0) return;
    // pack_format：自动匹配 MC 版本（未识别时默认 15）或用户自定义数值
    const packFormat =
      packMode === "auto"
        ? (packFormatForMc(modFile.mcVersion) ?? 15)
        : customPackFormat;
    const dir = await open({
      directory: true,
      title: "选择导出目录（生成 <modid>_zh_cn.zip 资源包）",
    });
    if (!dir) return;
    try {
      const path = await api.exportResourcePack(
        dir,
        modFile.modid,
        modFile.modName,
        translated,
        modFile.langFormat,
        packFormat,
      );
      message.success(`已导出汉化资源包：${path}（pack_format ${packFormat}）`);
      setExportSettingsOpen(false);
      setExportOpen(false);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleExportJar() {
    if (!modFile || !jarPath) return;
    const translated = entries.filter((e) => e.translation);
    if (translated.length === 0) {
      message.info("还没有译文可导出");
      return;
    }
    const saved = await save({
      defaultPath: `${modFile.modid}_zh_cn.jar`,
      filters: [{ name: "Minecraft 模组", extensions: ["jar"] }],
    });
    if (!saved) return;
    try {
      const path = await api.exportModJar(
        jarPath,
        saved,
        modFile.modid,
        translated,
        modFile.langFormat,
      );
      message.success(`已生成汉化模组：${path}`);
      setExportOpen(false);
    } catch (e) {
      message.error(String(e));
    }
  }

  const selectedEntry = useMemo(
    () => entries.find((e) => e.key === selectedKey) ?? null,
    [entries, selectedKey],
  );

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
          {modFile && (
            <Space size={4}>
              <Tag color="blue">{modFile.modName}</Tag>
              <Tag>{modFile.modid}</Tag>
              {modFile.version && <Tag>{modFile.version}</Tag>}
              <Tag>{LOADER_LABEL[modFile.loader]}</Tag>
              {modFile.mcVersion && <Tag>MC {modFile.mcVersion}</Tag>}
            </Space>
          )}
        </Space>
        <Button
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
        >
          设置
        </Button>
      </Header>

      <Content style={{ padding: 12, overflow: "auto" }}>
        {!modFile ? (
          <DropZone dragOver={dragOver} parsing={parsing} />
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
              <Button
                icon={<ExportOutlined />}
                disabled={translating}
                onClick={() => setExportOpen(true)}
              >
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
                icon={<CloudUploadOutlined />}
                disabled={translating}
                onClick={() => {
                  setModFile(null);
                  setJarPath(null);
                }}
              >
                导入其他模组
              </Button>
              <Typography.Text type="secondary">
                {entries.filter((e) => !e.translation).length} 条待翻译 /{" "}
                {entries.filter((e) => e.translation).length} 条已翻译
              </Typography.Text>
            </Space>

            {progress && (
              <Progress
                percent={progressPercent}
                size="small"
                style={{ marginBottom: 8 }}
                status={paused ? "active" : undefined}
                format={() =>
                  paused
                    ? `已暂停 ${progress.doneCount}/${progress.totalCount}`
                    : `${progress.doneCount}/${progress.totalCount}（批次 ${progress.batchIndex}/${progress.batchTotal}）`
                }
              />
            )}

            <EntryTable
              entries={entries}
              onEdit={editTranslation}
              onSelect={setSelectedKey}
            />
          </div>
        )}
      </Content>

      <Footer style={{ padding: "6px 12px", textAlign: "center" }}>
        <Typography.Text type="secondary">
          拖入 .jar 模组文件开始汉化 · 译文可人工编辑 · 导出资源包可直接放入
          resourcepacks 目录
        </Typography.Text>
      </Footer>

      <Modal
        title="导出"
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        footer={null}
        width={480}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Button
            block
            size="large"
            icon={<ExportOutlined />}
            onClick={() => void handleExportPack()}
          >
            导出汉化资源包（.zip，放入 resourcepacks 目录启用）
          </Button>
          <Button
            block
            size="large"
            icon={<SaveOutlined />}
            disabled={!jarPath}
            onClick={() => void handleExportJar()}
          >
            生成汉化后的模组 jar（复制原模组 + 写入中文，不覆盖原文件）
          </Button>
        </Space>
      </Modal>

      {/* 导出资源包设置：pack_format 按 MC 版本匹配或自定义数值 */}
      <Modal
        title="导出资源包设置"
        open={exportSettingsOpen}
        onCancel={() => setExportSettingsOpen(false)}
        onOk={() => void doExportPack()}
        okText="选择目录并导出"
        width={440}
      >
        <Typography.Text type="secondary">
          资源包 pack_format（依据 Minecraft Wiki；1.21.9+ 自动使用
          min_format/max_format）
        </Typography.Text>
        <Radio.Group
          value={packMode}
          onChange={(e) => setPackMode(e.target.value)}
          style={{ marginTop: 12, width: "100%" }}
        >
          <Radio value="auto" style={{ display: "block", marginBottom: 12 }}>
            自动匹配 MC 版本（检测到{" "}
            {packFormatForMc(modFile?.mcVersion ?? null) ?? "未知，将用 15"}）
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

      <Drawer
        title={selectedEntry ? `${selectedEntry.key}` : ""}
        open={!!selectedEntry}
        onClose={() => setSelectedKey(null)}
        width={420}
      >
        {selectedEntry && (
          <ContextPanel entry={selectedEntry} allEntries={entries} />
        )}
      </Drawer>

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
