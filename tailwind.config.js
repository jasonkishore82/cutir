/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#04060c", // the window behind the floating panels
        bg: "#080b12", // wells: inputs, viewer
        panel: "#0d1118", // floating panels
        raised: "#1a2232", // selected segments, hovered rows
        edge: "#222b3c", // hairlines
        accent: "#5b9dff",
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
