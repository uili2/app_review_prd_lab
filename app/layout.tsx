import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "App Review PRD Lab",
  description: "App Store 评论分析工作台"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
