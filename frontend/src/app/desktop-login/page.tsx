"use client";

import { useEffect, useState, type FormEvent } from "react";

type Provider = { id: string; name: string };

export default function DesktopLoginPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [handoffUrl, setHandoffUrl] = useState("");

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setError(query.get("desktopAuthError") || "");
    fetch("/api/auth/me").then(async (response) => {
      const data = await response.json() as { providers?: Provider[] };
      if (response.ok) setProviders(data.providers || []);
      else setError("无法连接本地桌面服务，请返回应用重试。");
    }).catch(() => setError("无法连接本地桌面服务，请返回应用重试。"));
  }, []);

  const returnToApp = (ticket: string) => {
    const url = `usagecopilot://auth?ticket=${encodeURIComponent(ticket)}`;
    setHandoffUrl(url);
    window.location.assign(url);
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/desktop/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json() as { ticket?: string; error?: string };
      if (!response.ok || !data.ticket) throw new Error(data.error || "登录失败，请重试。");
      returnToApp(data.ticket);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请重试。");
      setBusy(false);
    }
  };

  const startProviderLogin = async (provider: Provider) => {
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/desktop/oauth/${encodeURIComponent(provider.id)}`);
      const data = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !data.authorizationUrl) throw new Error(data.error || "无法开始授权。");
      window.location.assign(data.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法开始授权。");
      setBusy(false);
    }
  };

  return <main className="desktop-login-page">
    <style>{`
      *{box-sizing:border-box}.desktop-login-page{min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(145deg,#f5f5fb,#fbfaf6);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#28283a}
      .desktop-login-card{width:min(100%,410px);padding:34px;border:1px solid #e6e6ef;border-radius:18px;background:#fff;box-shadow:0 20px 70px #27274112}
      .desktop-login-mark{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 14px;border-radius:15px;background:#fff6dc;color:#e9a627;font-size:29px}
      .desktop-login-card h1{margin:0;text-align:center;font-size:23px}.desktop-login-card>p{margin:8px 0 25px;text-align:center;color:#77798a;font-size:13px}
      .desktop-login-form{display:grid;gap:12px}.desktop-login-form input{width:100%;height:43px;padding:0 12px;border:1px solid #dedfe8;border-radius:8px;background:#fff;font:inherit;font-size:14px;outline:0}.desktop-login-form input:focus{border-color:#8370d4;box-shadow:0 0 0 3px #8370d41c}
      .desktop-login-submit{height:43px;border:0;border-radius:8px;background:#6254bd;color:white;font:inherit;font-size:14px;font-weight:600;cursor:pointer}.desktop-login-submit:disabled,.desktop-provider:disabled{opacity:.55;cursor:wait}
      .desktop-login-error{margin:0;padding:10px;border-radius:7px;background:#fff1ef;color:#a7443a;font-size:12px}.desktop-login-divider{display:flex;align-items:center;gap:12px;margin:23px 0 15px;color:#9293a0;font-size:11px}.desktop-login-divider:before,.desktop-login-divider:after{height:1px;flex:1;background:#ececf1;content:""}
      .desktop-provider-list{display:grid;gap:9px}.desktop-provider{height:41px;border:1px solid #e0e1e9;border-radius:8px;background:white;color:#424354;font:inherit;font-size:13px;cursor:pointer}.desktop-provider:hover:not(:disabled){background:#f8f7fc;border-color:#c9c4e2}
      .desktop-login-return{display:block;margin-top:16px;text-align:center;color:#6254bd;font-size:13px}.desktop-login-footnote{margin:22px 0 0!important;color:#9b9ca8!important;font-size:11px!important}
    `}</style>
    <section className="desktop-login-card">
      <div className="desktop-login-mark" aria-hidden="true">☀</div>
      <h1>登录 Usage Copilot</h1>
      <p>使用远程账号登录，完成后将返回桌面应用。</p>
      <form className="desktop-login-form" onSubmit={submitPassword}>
        <input required autoComplete="username" maxLength={191} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名或邮箱" />
        <input required type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" />
        {error && <div className="desktop-login-error" role="alert">{error}</div>}
        <button className="desktop-login-submit" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
      </form>
      {providers.length > 0 && <>
        <div className="desktop-login-divider">或使用第三方账号</div>
        <div className="desktop-provider-list">{providers.map((provider) => <button className="desktop-provider" type="button" key={provider.id} disabled={busy} onClick={() => void startProviderLogin(provider)}>使用 {provider.name} 登录</button>)}</div>
      </>}
      {handoffUrl && <a className="desktop-login-return" href={handoffUrl}>如果没有自动返回，请点击这里</a>}
      <p className="desktop-login-footnote">账号认证由远程服务处理；聊天记录和个人配置保存在本机。</p>
    </section>
  </main>;
}
