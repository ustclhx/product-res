import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError, authPost } from "../../app/client";
import { useWorkspace } from "../../app/workspace";
import "./admin.css";

export default function AdminPasswordPage() {
  const { session, mode, reloadSession } = useWorkspace();
  const csrfToken = session?.csrf_token;
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (mode !== "pilot" || session?.user.is_admin !== true) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword.length < 12 || newPassword.length > 1024) { setError("新密码长度必须为 12 到 1024 个字符。"); return; }
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致。"); return; }
    if (newPassword === currentPassword) { setError("新密码必须与当前密码不同。"); return; }
    setBusy(true);
    try {
      const result = await authPost<{ password_changed: boolean }>("/admin/change-password", { current_password: currentPassword, new_password: newPassword }, csrfToken);
      if (result.password_changed !== true) throw new Error("服务器未确认密码已修改，请检查当前登录状态。");
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      await reloadSession();
      void navigate("/", { replace: true, state: { passwordChanged: true } });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) setError("登录状态已失效，请重新登录后再修改密码。");
      else if (!(reason instanceof ApiError) || reason.status === 0) setError("网络结果不确定。密码可能已修改；可尝试使用新密码重新登录，请勿自动重复提交。");
      else setError(reason instanceof Error ? reason.message : "密码修改失败，请稍后重试。");
    } finally { setBusy(false); }
  }

  return <section className="admin-page admin-password-page">
    <div className="page-heading"><div><h1>修改密码</h1><p>修改成功后，当前账号在所有设备上的登录都会失效。</p></div></div>
    <section className="panel admin-password-panel" aria-labelledby="password-form-title">
      <div className="card-heading"><h2 id="password-form-title">管理员密码</h2></div>
      {error && <div className="error" role="alert">{error}</div>}
      <form className="stack" onSubmit={event => void submit(event)}>
        <label className="field">当前密码<input type="password" autoComplete="current-password" maxLength={1024} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required /></label>
        <div className="field"><label htmlFor="new-password">新密码</label><input id="new-password" type="password" autoComplete="new-password" aria-describedby="new-password-help" minLength={12} maxLength={1024} value={newPassword} onChange={event => setNewPassword(event.target.value)} required /><small id="new-password-help">长度为 12 到 1024 个字符，且不能与当前密码相同。</small></div>
        <label className="field">确认新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
        <div className="form-actions"><button className="primary" type="submit" disabled={busy || !currentPassword || !newPassword || !confirmation}>{busy ? "正在修改…" : "修改密码"}</button></div>
      </form>
    </section>
  </section>;
}
