import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AdminPage } from "./admin/AdminPage";
import { ViewerPage } from "./viewer/ViewerPage";
import "./index.css";

const initialTheme = localStorage.getItem("theme") === "light" ? "light" : "dark";
document.documentElement.setAttribute("data-theme", initialTheme);

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);
  return [theme, () => setTheme((value) => value === "dark" ? "light" : "dark")] as const;
}

function App() {
  const [theme, toggleTheme] = useTheme();
  if (window.location.pathname.startsWith("/public/")) {
    const token = window.location.pathname.split("/").filter(Boolean)[1] ?? "";
    return <ViewerPage publicToken={token} theme={theme} toggleTheme={toggleTheme} />;
  }
  if (window.location.pathname.startsWith("/3dviewer/")) {
    return <ViewerPage theme={theme} toggleTheme={toggleTheme} />;
  }
  return <AdminPage theme={theme} toggleTheme={toggleTheme} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><App /></React.StrictMode>);
