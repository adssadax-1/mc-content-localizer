import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import zhContent from "./locales/zh.json";
import enContent from "./locales/en.json";

export type Language = "zh" | "en";

interface TranslationContextValue {
  t: (path: string, vars?: Record<string, string | number>) => string;
  locale: typeof zhCN | typeof enUS;
  currentLanguage: Language;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

const ZH = zhContent as Record<string, unknown>;
const EN = enContent as Record<string, unknown>;

/** 从嵌套 JSON 中按 "a.b.c" 路径取文案；支持 {var} 插值；缺 key 时回退中文 */
function resolve(
  content: Record<string, unknown>,
  path: string,
  vars?: Record<string, string | number>,
): string {
  const keys = path.split(".");
  let value: unknown = content;
  for (const key of keys) {
    if (value && typeof value === "object" && key in (value as Record<string, unknown>)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      value = undefined;
      break;
    }
  }
  let text: string | undefined = typeof value === "string" ? value : undefined;
  // 英文缺 key 时回退中文
  if (text === undefined && content !== ZH) {
    text = resolve(ZH, path, vars);
  }
  if (text === undefined) return path;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

export function useTranslation(language: Language = "zh"): TranslationContextValue {
  const content = language === "zh" ? ZH : EN;

  return useMemo(() => {
    const t = (path: string, vars?: Record<string, string | number>): string =>
      resolve(content, path, vars);
    return {
      t,
      locale: language === "zh" ? zhCN : enUS,
      currentLanguage: language,
    };
  }, [language, content]);
}

/** 在 TranslationProvider 内使用（App.tsx 已包裹） */
export function useTranslationContext(): TranslationContextValue {
  const context = useContext(TranslationContext);
  if (!context) {
    throw new Error("useTranslationContext must be used within TranslationContext.Provider");
  }
  return context;
}

export function TranslationProvider({
  children,
  language,
}: {
  children: ReactNode;
  language: Language;
}): ReactNode {
  const value = useTranslation(language);
  return (
    <TranslationContext.Provider value={value}>
      {children}
    </TranslationContext.Provider>
  );
}