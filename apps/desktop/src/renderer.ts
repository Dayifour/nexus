// Point d'entrée du renderer (chargé par index.html, CSP stricte : aucun script inline).
// Le préambule React Refresh est importé EN PREMIER : en dev il remplace le script inline que la CSP bloque ;
// en production ce module virtuel est vide.
import "@vitejs/plugin-react/preamble";
import "./renderer/styles.css";
import "./renderer/ux.css";
import { mount } from "./renderer/main.tsx";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Nexus root element is missing.");
mount(root);
