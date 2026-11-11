// Install the stub before any app module asks Tauri for its window.
import "./tauri";
import "../global.css";

document.documentElement.setAttribute("data-theme", "light");
