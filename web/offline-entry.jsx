import React from "react";
import { createRoot } from "react-dom/client";
import { Studio } from "./src/Studio.jsx";

createRoot(document.getElementById("root")).render(
  <Studio story={location.pathname === "/studio.html"} />,
);
