/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0f1115",
        panel: "#161a21",
        edge: "#262c36",
        accent: "#e0709a",
      },
    },
  },
  plugins: [],
};
