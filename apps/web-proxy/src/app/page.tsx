"use client";

import { useState } from "react";

const EXAMPLES = [
  "https://example.com",
  "https://wikipedia.org",
  "https://news.ycombinator.com",
  "https://github.com",
];

export default function Home() {
  const [url, setUrl] = useState("");

  function navigate(target: string) {
    let value = target.trim();
    if (!value) return;
    if (!value.startsWith("http://") && !value.startsWith("https://")) {
      value = "https://" + value;
    }
    window.location.href = `/proxy?url=${encodeURIComponent(value)}`;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate(url);
  }

  return (
    <main className="page">
      <div className="hero">
        <div className="logo">
          <div className="logo-icon">🌐</div>
          WebProxy
        </div>
        <p className="tagline">
          Browse any website through the proxy — HTML, CSS, JS, images, fonts,
          and more.
        </p>
      </div>

      <div className="search-card">
        <span className="search-label">Enter a URL to browse</span>

        <form className="search-row" onSubmit={handleSubmit}>
          <input
            className="url-input"
            type="text"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          <button className="go-btn" type="submit">
            Browse →
          </button>
        </form>

        <div className="examples">
          <span className="examples-label">Try an example:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="example-chip"
              onClick={() => navigate(ex)}
            >
              {ex.replace("https://", "")}
            </button>
          ))}
        </div>
      </div>

      <div className="features">
        <div className="feature">
          <div className="feature-icon">🔗</div>
          <div className="feature-title">Full URL Rewriting</div>
          <div className="feature-desc">
            href, src, srcset, action, and CSS url() are all rewritten to route
            through the proxy.
          </div>
        </div>
        <div className="feature">
          <div className="feature-icon">⚡</div>
          <div className="feature-title">Runtime Interception</div>
          <div className="feature-desc">
            fetch() and XMLHttpRequest are intercepted so dynamic requests also
            go through the proxy.
          </div>
        </div>
        <div className="feature">
          <div className="feature-icon">📦</div>
          <div className="feature-title">All Asset Types</div>
          <div className="feature-desc">
            HTML, CSS, JS, images, fonts, JSON — all proxied with correct
            content-type headers.
          </div>
        </div>
        <div className="feature">
          <div className="feature-icon">🍪</div>
          <div className="feature-title">Cookie Forwarding</div>
          <div className="feature-desc">
            Request and response cookies are forwarded as faithfully as the
            same-origin policy allows.
          </div>
        </div>
      </div>

      <p className="footer">
        Powered by Next.js · Deploy to Vercel for best performance
      </p>
    </main>
  );
}
