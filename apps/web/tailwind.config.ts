import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        vault: {
          bg: "#05070a",
          surface: "#0b0f16",
          border: "#1b212c",
          gold: "#c9a24b",
          up: "#20c997",
          down: "#e5484d",
        },
      },
      fontFamily: {
        display: ["'Sora'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
