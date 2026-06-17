import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Geist", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"]
      },
      colors: {
        steel: {
          50: "#f5f7fa",
          100: "#e7edf5",
          200: "#c9d5e5",
          300: "#9baec8",
          400: "#6f839f",
          500: "#526176",
          600: "#3d4654",
          700: "#2c323b",
          800: "#1d2127",
          900: "#111419",
          950: "#080a0d"
        }
      },
      boxShadow: {
        panel: "0 18px 50px rgb(0 0 0 / 28%)",
        menu: "0 14px 34px rgb(0 0 0 / 32%)"
      }
    }
  },
  plugins: []
} satisfies Config;
