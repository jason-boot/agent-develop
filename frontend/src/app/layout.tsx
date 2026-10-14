import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "你好 - Little Sunshine",
  description: "通过对话查询模型使用记录和费用",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
