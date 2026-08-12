import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // 白亮 + 天空蓝
          colorPrimary: "#4A90D9",
          colorBgLayout: "#F5F6F8",
          colorBgContainer: "#FFFFFF",
          colorText: "#1F2937",
          colorTextSecondary: "#6B7280",
          colorBorder: "#E6E8EB",
          colorBorderSecondary: "#EFF1F4",
          colorSuccess: "#16A34A",
          colorWarning: "#D97706",
          colorError: "#DC2626",
          borderRadius: 10,
          fontSize: 13,
        },
        components: {
          Layout: {
            headerBg: "#FFFFFF",
            siderBg: "#FFFFFF",
            bodyBg: "#F5F6F8",
            footerBg: "#FFFFFF",
          },
          Table: {
            headerBg: "#F9FAFB",
            headerColor: "#4B5563",
            borderColor: "#F0F2F5",
          },
          Card: {
            colorBorderSecondary: "#E6E8EB",
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
