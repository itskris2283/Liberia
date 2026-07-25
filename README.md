# 📚 Liberia - Modern Immersive eBook & PDF Reader

**Liberia** is a state-of-the-art, high-performance Progressive Web Application (PWA) designed to transform your digital reading experience. Featuring realistic page-flip physics, dynamic ambient lighting, customizable typography, and offline storage, Liberia brings the tactile joy of reading physical books directly to your web browser.

---

## ✨ Features

- **📖 Realistic Page Flip & Spread View:** Smooth 3D page-flipping animations with support for both single-page and two-page spread layouts.
- **🌈 Dynamic Ambient Glow:** Automatically extracts color palettes from book covers and PDF pages to cast a subtle, immersive ambient light across your screen.
- **🔒 Cross-Browser Immersive Mode:** Dedicated fullscreen and locked immersive reading modes designed to eliminate distractions, with bulletproof support across desktop browsers and touch devices (including Apple iOS/iPadOS Safari).
- **💾 Zero-Cost Offline Storage:** Built entirely on top of browser-native **`IndexedDB`**. Upload your PDFs once and access them anytime, anywhere—even 100% offline—with zero cloud server costs or privacy trade-offs.
- **🎨 Custom Reading Themes:** Tailor your reading environment with curated color themes (Light, Sepia, Night, OLED Dark, Nord, Solarized), adjustable font sizes, line spacing, and page margins.
- **📑 Bookmarks & Reading Stats:** Easily mark important pages and track your reading habits, session times, and completed books with rich visual statistics.
- **📱 PWA & Mobile Ready:** Installable as a native mobile or desktop application via Service Workers, offering responsive layouts and touch-optimized gestures.

---

## 🚀 Getting Started

Since Liberia is a 100% static client-side web application, running it locally or deploying it to the web is effortless.

### Running Locally

1. Clone the repository:
   ```bash
   git clone https://github.com/itskris2283/Liberia.git
   cd Liberia
   ```
2. Serve the directory using any local web server. For example, using Python or Node:
   ```bash
   # Using Python 3
   python -m http.server 8000

   # OR using Node (npx serve)
   npx serve .
   ```
3. Open your browser and navigate to `http://localhost:8000`.

### Deploying to the Web

Liberia can be deployed instantly for free to static hosting providers like **Netlify**, **Vercel**, **Cloudflare Pages**, or **GitHub Pages**.

- **Vercel / Netlify:** Simply connect your GitHub repository, leave the build settings empty (static directory), and deploy.

---

## 🛠️ Technology Stack

- **Core:** Vanilla JavaScript (ES6+), HTML5, and CSS3 (with CSS Variables & Animations).
- **PDF Rendering:** [PDF.js](https://mozilla.github.io/pdf.js/) for high-fidelity PDF page rendering and text layer extraction.
- **Storage Engine:** Browser-native `IndexedDB` and `localStorage` for high-capacity local file persistence and settings caching.
- **PWA:** Web App Manifest and Service Workers for installability and offline caching.

---

## 🔒 Privacy & Data

Liberia operates on a **"Bring Your Own Book"** local model. All uploaded PDF documents, reading logs, and personal statistics remain encrypted and stored locally on your personal device. No telemetry, no tracking cookies, and no cloud uploads.

---

## 📝 License

This project is open-source and available under the MIT License.
