import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".claude/worktrees/**",
      ".next/**",
      // P1-4：静态导出产物与它的构建目录（自动生成，不参与 lint）。
      ".next-static/**",
      "electron/dist/**",
      "agent-host/dist/**",
      "release/**",
      "out/**",
      "coverage/**",
      "tmp/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
