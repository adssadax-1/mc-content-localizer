import { useTranslationContext } from "../i18n";
import { PROVIDER_PRESETS } from "../types";

/** 服务商品牌色（近似官方主色，纯离线 SVG，无网络依赖） */
const BRAND: Record<string, string | [string, string]> = {
  zhipu: "#3859FF",
  qwen: "#615CED",
  deepseek: "#4D6BFE",
  doubao: ["#F5222D", "#FA8C16"],
  moonshot: "#16161A",
  hunyuan: "#0052D9",
  siliconflow: "#7C5CFF",
  gemini: ["#4285F4", "#9B72CB"],
  openai: "#10A37F",
  openrouter: "#5E6AD2",
  custom: "#8C8C8C",
};

/** 简约服务商图标：品牌色圆角方块 + 字母/符号（白） */
export function ProviderIcon({ id, size = 30 }: { id: string; size?: number }) {
  const brand = BRAND[id] ?? "#8C8C8C";
  const gid = `pg-${id}`;
  const fill = Array.isArray(brand) ? `url(#${gid})` : brand;
  const half = size / 2;

  const glyph = (() => {
    switch (id) {
      case "gemini": // 四角星
        return (
          <path
            d={`M ${half} ${size * 0.18} C ${half * 1.15} ${half * 0.85}, ${half * 1.35} ${half * 1.05}, ${size * 0.82} ${half} C ${half * 1.35} ${half * 0.95}, ${half * 1.15} ${half * 1.15}, ${half} ${size * 0.82} C ${half * 0.85} ${half * 1.15}, ${half * 0.65} ${half * 1.35}, ${size * 0.18} ${half} C ${half * 0.65} ${half * 0.95}, ${half * 0.85} ${half * 0.85}, ${half} ${size * 0.18} Z`}
            fill="#fff"
          />
        );
      case "moonshot": // 月牙
        return (
          <path
            d={`M ${size * 0.66} ${size * 0.16} A ${half * 0.78} ${half * 0.78} 0 1 0 ${size * 0.66} ${size * 0.84} A ${half * 0.62} ${half * 0.62} 0 1 1 ${size * 0.66} ${size * 0.16} Z`}
            fill="#fff"
          />
        );
      case "openai": // 六边形结（简化）
        return (
          <path
            d={`M ${half} ${size * 0.2} L ${size * 0.74} ${size * 0.35} L ${size * 0.74} ${size * 0.65} L ${half} ${size * 0.8} L ${size * 0.26} ${size * 0.65} L ${size * 0.26} ${size * 0.35} Z`}
            fill="none"
            stroke="#fff"
            strokeWidth={size * 0.09}
            strokeLinejoin="round"
          />
        );
      case "custom": // 齿轮（简化：圆 + 齿）
        return (
          <g stroke="#fff" strokeWidth={size * 0.07} strokeLinecap="round">
            <circle cx={half} cy={half} r={size * 0.16} fill="none" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
              const rad = (a * Math.PI) / 180;
              const r1 = size * 0.26;
              const r2 = size * 0.36;
              return (
                <line
                  key={a}
                  x1={half + r1 * Math.cos(rad)}
                  y1={half + r1 * Math.sin(rad)}
                  x2={half + r2 * Math.cos(rad)}
                  y2={half + r2 * Math.sin(rad)}
                />
              );
            })}
          </g>
        );
      case "openrouter": // 路由节点
        return (
          <g stroke="#fff" strokeWidth={size * 0.08} strokeLinecap="round">
            <circle cx={half} cy={size * 0.3} r={size * 0.08} fill="#fff" stroke="none" />
            <circle cx={size * 0.28} cy={size * 0.68} r={size * 0.08} fill="#fff" stroke="none" />
            <circle cx={size * 0.72} cy={size * 0.68} r={size * 0.08} fill="#fff" stroke="none" />
            <line x1={half} y1={size * 0.3} x2={size * 0.28} y2={size * 0.68} />
            <line x1={half} y1={size * 0.3} x2={size * 0.72} y2={size * 0.68} />
            <line x1={size * 0.28} y1={size * 0.68} x2={size * 0.72} y2={size * 0.68} />
          </g>
        );
      default: {
        // 字母标识
        const letters: Record<string, string> = {
          zhipu: "Z",
          qwen: "Q",
          deepseek: "D",
          doubao: "豆",
          hunyuan: "混",
          siliconflow: "硅",
        };
        const ch = letters[id] ?? "?";
        return (
          <text
            x={half}
            y={half}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"
            fontWeight="bold"
            fontSize={id === "doubao" || id === "hunyuan" || id === "siliconflow" ? size * 0.5 : size * 0.56}
            fill="#fff"
          >
            {ch}
          </text>
        );
      }
    }
  })();

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", flexShrink: 0 }} aria-hidden="true">
      {Array.isArray(brand) && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={brand[0]} />
            <stop offset="1" stopColor={brand[1]} />
          </linearGradient>
        </defs>
      )}
      <rect width={size} height={size} rx={size * 0.24} fill={fill} />
      {glyph}
    </svg>
  );
}

/** 服务商选择网格（antd Form 受控组件）：图标 + 名称卡片，替代下拉框便于查找 */
export function ProviderGrid({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (v: string) => void;
}) {
  const { t } = useTranslationContext();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 8,
        width: "100%",
      }}
    >
      {Object.entries(PROVIDER_PRESETS).map(([id, p]) => {
        const active = value === id;
        return (
          <div
            key={id}
            className="provider-grid-card"
            onClick={() => onChange?.(id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              padding: "12px 4px 8px",
              borderRadius: 10,
              border: `1.5px solid ${active ? "#4A90D9" : "var(--border-color, #E6E8EB)"}`,
              background: active ? "rgba(74,144,217,0.08)" : "transparent",
              cursor: "pointer",
              transition: "all 0.15s",
              userSelect: "none",
            }}
          >
            <ProviderIcon id={id} size={30} />
            <span
              style={{
                fontSize: 12,
                textAlign: "center",
                lineHeight: 1.2,
                color: active ? "#1F2937" : "inherit",
                fontWeight: active ? 600 : 400,
              }}
            >
              {t(`providers.${id}`) !== `providers.${id}` ? t(`providers.${id}`) : p.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 各服务商的补充说明（选中后显示在网格下方） */
export const PROVIDER_HINTS: Record<string, string> = {
  doubao: "豆包：模型名填具体模型 ID，或火山方舟控制台创建的接入点 ID（ep- 开头）",
  moonshot: "Kimi：模型迭代较快，可点击「获取模型列表」查看可用模型",
  openai: "OpenAI：国内网络访问不稳定，可能需要代理",
  openrouter: "OpenRouter：一个 Key 调全平台，模型 ID 带 vendor 前缀（如 google/gemini-2.5-flash）",
  custom: "自定义：填入任意 OpenAI 兼容端点（Base URL + 模型名）",
};
