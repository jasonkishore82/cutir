/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#060607", // the window behind the floating panels
        bg: "#0d0d0f", // wells: inputs, viewer
        panel: "#161618", // floating panels
        raised: "#222226", // selected segments, hovered rows
        edge: "#2a2a2f", // hairlines
        accent: "#e0709a",
      },
      borderRadius: {
        DEFAULT: "8px", // every plain `rounded` is softer, app-wide
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', "Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
