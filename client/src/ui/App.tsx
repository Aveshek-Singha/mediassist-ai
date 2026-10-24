import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, CalendarDays, Check, CircleAlert, Code2, FileHeart, KeyRound, LayoutDashboard, LogOut, Menu, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Stethoscope, Webhook, X, Settings as SettingsIcon, Copy, CheckCircle2 } from 'lucide-react';
import { ApiError, api, apiBaseUrl, type Automation, type Booking, type Delivery, type Endpoint, type LogEntry, type User, type VisitNote } from '../api';

type Tab = 'overview' | 'bookings' | 'widget' | 'notes' | 'automations' | 'webhooks' | 'logs' | 'settings';
type Props = { token: string; user: User; onLogout: () => void; onSessionChanged: (user: User) => void };

const nav: Array<{ id: Tab; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'bookings', label: 'Bookings', icon: CalendarDays },
  { id: 'widget', label: 'Widget setup', icon: Code2, adminOnly: true },
  { id: 'notes', label: 'Visit notes', icon: FileHeart },
  { id: 'automations', label: 'Automations', icon: Sparkles, adminOnly: true },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook, adminOnly: true },
  { id: 'logs', label: 'Log viewer', icon: Activity, adminOnly: true },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
];

function MediAssistMark() {
  return <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4 17h5l3-7 5 13 3-8 2 3h6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="4" cy="17" r="1.4" fill="currentColor" /><circle cx="28" cy="18" r="1.4" fill="currentColor" /></svg>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState(import.meta.env.DEV ? 'admin@mediassist.local' : '');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState<{ challenge: string; mode: 'setup' | 'verify' } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pendingUser, setPendingUser] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setLoading(true);
    try {
      const result = await api<{ user?: User; mfaRequired?: boolean; challenge?: string; mode?: 'setup' | 'verify' }>('/auth/login', null, { method: 'POST', body: JSON.stringify({ email, password }) });
      if (result.mfaRequired && result.challenge && result.mode) setMfa({ challenge: result.challenge, mode: result.mode });
      else if (result.user) onLogin(result.user);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to sign in.'); }
    finally { setLoading(false); }
  }
  async function beginSetup() {
    if (!mfa) return;
    setError(''); setLoading(true);
    try { setSetup(await api<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup', mfa.challenge, { method: 'POST', body: '{}' })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to begin authenticator setup.'); }
    finally { setLoading(false); }
  }
  async function verifyMfa(event: React.FormEvent) {
    event.preventDefault(); if (!mfa) return;
    setError(''); setLoading(true);
    try {
      if (mfa.mode === 'setup') {
        const result = await api<{ user: User; recoveryCodes: string[] }>('/auth/mfa/enable', mfa.challenge, { method: 'POST', body: JSON.stringify({ code: mfaCode }) });
        setPendingUser(result.user); setRecoveryCodes(result.recoveryCodes); setMfaCode('');
      } else {
        const result = await api<{ user: User }>('/auth/mfa/verify', mfa.challenge, { method: 'POST', body: JSON.stringify(useRecoveryCode ? { recoveryCode: mfaCode } : { code: mfaCode }) });
        onLogin(result.user);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to verify the authenticator code.'); }
    finally { setLoading(false); }
  }
  return <main className="login-shell"><section className="login-card">
    <div className="login-brand"><div className="brand-mark"><MediAssistMark /></div><div><b>MediAssist</b><span>Clinic operations</span></div></div>
    <h1>{pendingUser ? 'Save recovery codes' : mfa ? (mfa.mode === 'setup' ? 'Secure your admin account' : 'Verify your identity') : 'Sign in'}</h1>
    <p className="muted">{pendingUser ? 'Store these codes somewhere private. Each code can be used once if you lose access to your authenticator.' : mfa ? (mfa.mode === 'setup' ? 'Production administrator accounts require an authenticator app.' : 'Enter the current code from your authenticator app.') : 'Access appointments, visit notes, and connected services for this clinic.'}</p>
    {pendingUser ? <div className="mfa-recovery"><div className="recovery-code-list">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button className="primary wide" onClick={() => onLogin(pendingUser)}>I saved these codes <ArrowUpRight size={16} /></button></div> : mfa ? <div className="login-form">
      {mfa.mode === 'setup' && !setup && <button className="primary wide" onClick={() => void beginSetup()} disabled={loading}>{loading ? 'Preparing…' : 'Set up authenticator'}<ShieldCheck size={15} /></button>}
      {setup && <div className="mfa-setup-box"><b>Enter this key in your authenticator app</b><code>{setup.secret}</code><small>Or open this setup link on a device with an authenticator app:</small><a href={setup.otpauthUrl}>{setup.otpauthUrl}</a></div>}
      {(mfa.mode === 'verify' || setup) && <form onSubmit={verifyMfa} className="login-form"><label>{useRecoveryCode ? 'Recovery code' : 'Authenticator code'}<input autoComplete="one-time-code" inputMode={useRecoveryCode ? 'text' : 'numeric'} type="text" maxLength={useRecoveryCode ? 64 : 6} value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} required /></label>{error && <div className="form-error"><CircleAlert size={15} />{error}</div>}<button className="primary wide" disabled={loading}>{loading ? 'Verifying…' : mfa.mode === 'setup' ? 'Enable MFA' : 'Verify and sign in'}<ArrowUpRight size={16} /></button>{mfa.mode === 'verify' && <button className="text-button" type="button" onClick={() => { setUseRecoveryCode((value) => !value); setMfaCode(''); setError(''); }}>{useRecoveryCode ? 'Use authenticator code' : 'Use a recovery code'}</button>}</form>}
      {mfa.mode === 'setup' && !setup && error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
      <button className="text-button" onClick={() => { setMfa(null); setSetup(null); setMfaCode(''); setError(''); setPassword(''); }}>Back to sign in</button>
    </div> : <form onSubmit={submit} className="login-form"><label>Email<input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}<button className="primary wide" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}<ArrowUpRight size={16} /></button>
    </form>}{!mfa && !pendingUser && import.meta.env.DEV && <div className="demo-credentials">Local demo account: <b>admin@mediassist.local</b><br />Password: <code>change-this-demo-password</code></div>}<div className="login-foot"><ShieldCheck size={14} /> Private clinic workspace · Your session stays in this browser</div>
  </section></main>;
}

function Shell({ token, user, onLogout, onSessionChanged }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [health, setHealth] = useState<'checking' | 'ok' | 'degraded' | 'offline'>('checking');
  const title = nav.find((item) => item.id === tab)?.label ?? 'Overview';
  const refresh = () => setRefreshKey((value) => value + 1);
  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const result = await api<{ status: string }>('/health');
        if (active) setHealth(result.status === 'ok' ? 'ok' : 'degraded');
      } catch (reason) {
        if (active) setHealth(reason instanceof Error && 'status' in reason ? 'degraded' : 'offline');
      }
    };
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark small"><MediAssistMark /></div><div><b>MediAssist</b><small>Clinic operations</small></div><button className="icon-button nav-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="clinic-switch"><div className="clinic-avatar"><Stethoscope size={16} /></div><div><b>Clinic workspace</b><small>Single-clinic deployment</small></div></div>
      <span className="nav-caption">Workspace</span><nav>{nav.filter((item) => !item.adminOnly || user.role === 'admin').map((item) => <button key={item.id} className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => { setTab(item.id); setMobileNav(false); }}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-spacer" /><div className={`sidebar-status health-${health}`}><span className="status-dot" /><span>{health === 'checking' ? 'Checking service health' : health === 'ok' ? 'Services operational' : health === 'degraded' ? 'Service degraded' : 'API unavailable'}</span><span className="status-chevron" aria-hidden="true">·</span></div>
      <div className="profile"><div className="profile-avatar">{user.email.charAt(0).toUpperCase()}</div><div className="profile-meta"><b>{user.email.split('@')[0]}</b><small>{user.role}</small></div><button className="icon-button" onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button></div>
    </aside>
    {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    <main className="main-area"><header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button><div className="crumb"><span>MediAssist</span><b>/</b><strong>{title}</strong></div><div className="topbar-right"><button className="icon-button" onClick={refresh} title="Refresh data" aria-label="Refresh"><RefreshCw size={16} /></button><button className="top-avatar top-avatar-button" onClick={() => setTab('settings')} title="Account settings" aria-label="Open account settings">{user.email.charAt(0).toUpperCase()}</button></div></header>
      <div className="content-area"><Page tab={tab} token={token} user={user} refreshKey={refreshKey} onNavigate={setTab} onSessionChanged={onSessionChanged} /></div>
    </main>
  </div>;
}

function Page({ tab, token, user, refreshKey, onNavigate, onSessionChanged }: { tab: Tab; token: string; user: User; refreshKey: number; onNavigate: (tab: Tab) => void; onSessionChanged: (user: User) => void }) {
  if (tab === 'overview') return <Overview token={token} user={user} refreshKey={refreshKey} onNavigate={onNavigate} />;
  if (tab === 'bookings') return <Bookings token={token} refreshKey={refreshKey} />;
  if (tab === 'widget') return <WidgetSetup token={token} refreshKey={refreshKey} />;
  if (tab === 'notes') return <Notes token={token} refreshKey={refreshKey} />;
  if (tab === 'automations') return <Automations token={token} refreshKey={refreshKey} />;
  if (tab === 'webhooks') return <Webhooks token={token} refreshKey={refreshKey} />;
  if (tab === 'logs') return <Logs token={token} refreshKey={refreshKey} />;
  return <AccountSettings token={token} user={user} onSessionChanged={onSessionChanged} />;
}

function AccountSettings({ token, user, onSessionChanged }: { token: string; user: User; onSessionChanged: (user: User) => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setNotice('');
    if (newPassword.length < 12) { setError('Use at least 12 characters for your new password.'); return; }
    if (newPassword !== confirmPassword) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/auth/change-password', token, {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword })
      });
      onSessionChanged(result.user);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setNotice('Password updated. Your other sessions have been signed out.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update your password.'); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading title="Account settings" description="Manage sign-in and team access for this clinic workspace." />
    <div className="settings-grid">
      <section className="card account-card">
        <div className="card-head"><div><h2>Profile</h2></div><div className="settings-avatar">{user.email.charAt(0).toUpperCase()}</div></div>
        <dl className="account-details"><div><dt>Email address</dt><dd>{user.email}</dd></div><div><dt>Workspace role</dt><dd className="role-value">{user.role}</dd></div></dl>
        <div className="account-note"><ShieldCheck size={15} /> This workspace is scoped to one clinic installation.</div>
      </section>
      <section className="card password-card">
        <h2>Change password</h2><p>Use a unique password with at least 12 characters. Changing it signs out other active sessions.</p>
        <form onSubmit={changePassword} className="password-form">
          <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
          <label>New password<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
          {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
          {notice && <div className="success-banner"><CheckCircle2 size={15} />{notice}</div>}
          <button className="primary" disabled={busy}>{busy ? <><span className="spinner" /> Updating…</> : <><KeyRound size={14} /> Update password</>}</button>
        </form>
      </section>
    </div>
    {user.role === 'admin' && <TeamManagement token={token} currentUser={user} />}
    {import.meta.env.PROD && user.role === 'admin' && <RecoveryCodeSettings token={token} />}
    <section className="card security-guidance"><ShieldCheck size={18} /><div><b>Use approved systems for patient information.</b><span>Visit-note redaction is best-effort and does not provide a compliance guarantee. Follow your clinic's approved data-handling policy.</span></div></section>
  </>;
}

function RecoveryCodeSettings({ token }: { token: string }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function rotateCodes(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setCodes([]);
    try { const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', token, { method: 'POST', body: JSON.stringify({ code }) }); setCodes(result.recoveryCodes); setCode(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to rotate recovery codes.'); }
    finally { setBusy(false); }
  }
  return <section className="card recovery-settings"><div className="card-head"><div><h2>Authenticator recovery codes</h2><p>Replace the current codes after using one or if you need to store a fresh set.</p></div><span className="privacy-chip"><ShieldCheck size={13} /> Admin MFA</span></div>
    <form className="recovery-rotate-form" onSubmit={rotateCodes}><label>Current authenticator code<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required /></label><button className="secondary" disabled={busy}>{busy ? 'Rotating…' : 'Generate new recovery codes'}</button></form>
    {error && <div className="error-banner"><CircleAlert size={15} />{error}</div>}{codes.length > 0 && <div className="mfa-recovery"><p>Save these codes somewhere private. The old codes no longer work.</p><div className="recovery-code-list">{codes.map((item) => <code key={item}>{item}</code>)}</div><button className="text-button" onClick={() => setCodes([])}>I saved these codes</button></div>}
  </section>;
}

function TeamManagement({ token, currentUser }: { token: string; currentUser: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'staff'>('staff');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await api<{ users: User[] }>('/users', token); setUsers(result.users); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load team members.'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  async function addUser(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await api('/users', token, { method: 'POST', body: JSON.stringify({ email, password, role }) });
      setEmail(''); setPassword(''); setRole('staff'); setNotice('Team member added. Share the temporary password through your approved secure channel.');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add this user.'); }
    finally { setBusy(false); }
  }
  async function updateUser(member: User, changes: { role?: 'admin' | 'staff'; active?: boolean }) {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/users/${member.id}`, token, { method: 'PATCH', body: JSON.stringify(changes) });
      setNotice(`${member.email}'s access was updated.`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update this user.'); }
    finally { setBusy(false); }
  }
  return <section className="card team-card">
    <div className="card-head"><div><h2>Team access</h2><p>Invite clinic staff and manage administrator access.</p></div><span className="privacy-chip"><ShieldCheck size={13} /> Admin only</span></div>
    <form className="team-create-form" onSubmit={addUser}>
      <label>Email<input type="email" maxLength={254} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Temporary password<input type="password" minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><small>At least 12 characters; the new user can change it after signing in.</small></label>
      <label>Role<select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'staff')}><option value="staff">Staff</option><option value="admin">Administrator</option></select></label>
      <button className="primary" disabled={busy}>{busy ? 'Adding…' : 'Add team member'}</button>
    </form>
    {error && <div className="error-banner"><CircleAlert size={15} />{error}</div>}{notice && <div className="success-banner"><CheckCircle2 size={15} />{notice}</div>}
    {loading ? <LoadingLine /> : users.length ? <div className="table-wrap team-table"><table><thead><tr><th>Team member</th><th>Role</th><th>Status</th><th>Access</th></tr></thead><tbody>{users.map((member) => <tr key={member.id}><td>{member.email}{member.id === currentUser.id && <small className="table-sub">You</small>}</td><td><select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy || member.id === currentUser.id} onChange={(event) => void updateUser(member, { role: event.target.value as 'admin' | 'staff' })}><option value="staff">Staff</option><option value="admin">Administrator</option></select></td><td><StatusBadge value={member.active === false ? 'Disabled' : 'Active'} /></td><td><button className="text-button" disabled={busy || member.id === currentUser.id} onClick={() => void updateUser(member, { active: member.active === false })}>{member.active === false ? 'Enable' : 'Disable'}</button></td></tr>)}</tbody></table></div> : <Empty title="No team members" detail="Add a user to grant staff access to the clinic workspace." />}
  </section>;
}

function useLoad<T>(key: string, token: string, path: string, refreshKey: number, fallback: T, enabled = true) {
  const [data, setData] = useState<T>(fallback);
  const fallbackRef = useRef(fallback);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!enabled) { setData(fallbackRef.current); setError(''); setLoading(false); return; }
    setLoading(true); setError('');
    try { setData(await api<T>(path, token)); } catch (reason) { setError(reason instanceof Error ? reason.message : `Unable to load ${key}.`); }
    finally { setLoading(false); }
  }, [key, token, path, enabled]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return { data, error, loading, reload: load, setData };
}

function PageHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}

function ErrorBanner({ children }: { children: React.ReactNode }) { return children ? <div className="error-banner"><CircleAlert size={16} />{children}</div> : null; }
function LoadingLine() { return <div className="loading-line"><span /> Loading workspace data…</div>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><div className="empty-icon"><Activity size={20} /></div><b>{title}</b><span>{detail}</span></div>; }
function StatusBadge({ value }: { value: string }) { return <span className={`badge badge-${value.toLowerCase().replace(/[^a-z]/g, '-')}`}><i />{value}</span>; }
function dateTime(value: string) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

function Overview({ token, user, refreshKey, onNavigate }: { token: string; user: User; refreshKey: number; onNavigate: (tab: Tab) => void }) {
  const isAdmin = user.role === 'admin';
  const { data: bookingData, loading: bookingLoading, error: bookingError } = useLoad<{ bookings: Booking[] }>('bookings', token, '/medibook/bookings', refreshKey, { bookings: [] });
  const { data: noteData, loading: noteLoading, error: noteError } = useLoad<{ notes: VisitNote[] }>('notes', token, '/notes', refreshKey, { notes: [] });
  const { data: deliveryData, loading: deliveryLoading, error: deliveryError } = useLoad<{ deliveries: Delivery[] }>('deliveries', token, '/webhooks/deliveries', refreshKey, { deliveries: [] }, isAdmin);
  const { data: automationData, loading: automationLoading, error: automationError } = useLoad<{ automations: Automation[] }>('automations', token, '/automations', refreshKey, { automations: [] }, isAdmin);
  const bookings = useMemo(() => bookingData.bookings ?? [], [bookingData.bookings]);
  const notes = noteData.notes ?? [];
  const deliveries = deliveryData.deliveries ?? [];
  const automationCount = (automationData.automations ?? []).filter((item) => item.enabled).length;
  const today = dateInputValue(new Date());
  const todayAppointments = useMemo(() => bookings
    .filter((booking) => booking.slot.date === today)
    .sort((a, b) => a.slot.time.localeCompare(b.slot.time))
    .slice(0, 5), [bookings, today]);
  const nextAppointments = useMemo(() => bookings
    .filter((booking) => booking.slot.date > today)
    .sort((a, b) => a.slot.date.localeCompare(b.slot.date) || a.slot.time.localeCompare(b.slot.time))
    .slice(0, 3), [bookings, today]);
  const completedNotes = notes.filter((note) => note.status === 'completed').length;
  const waitingDeliveries = deliveries.filter((delivery) => delivery.status === 'pending').length;
  const failedDeliveries = deliveries.filter((delivery) => delivery.status === 'failed').length;
  const dataErrors = [bookingError && `Bookings: ${bookingError}`, noteError && `Notes: ${noteError}`, isAdmin && deliveryError && `Webhooks: ${deliveryError}`, isAdmin && automationError && `Automations: ${automationError}`].filter(Boolean).join(' · ');
  return <>
    <PageHeading title="Clinic operations" description="Today's patient schedule and connected services." action={<button className="primary" onClick={() => onNavigate('bookings')}><CalendarDays size={16} /> Book appointment</button>} />
    <ErrorBanner>{dataErrors}</ErrorBanner>
    <div className="metric-grid">
      <Metric label="Completed notes" value={noteLoading ? '–' : String(completedNotes)} detail="Structured drafts in history" />
      <Metric label="Enabled automations" value={!isAdmin ? 'Admin only' : automationLoading ? '–' : String(automationCount)} detail="Workflows ready for events" />
    </div>
    <div className="overview-grid">
      <div className="overview-primary">
        <section className="card schedule-card"><div className="card-head"><h2>Today's appointments</h2><button className="text-button" onClick={() => onNavigate('bookings')}>All bookings <ArrowUpRight size={14} /></button></div>
          {bookingLoading ? <LoadingLine /> : bookingError ? <Empty title="Today's schedule unavailable" detail="Check the MediBook connection to load appointments." /> : todayAppointments.length ? <div className="booking-list">{todayAppointments.map((booking) => <div className="booking-row" key={booking.id}><div className="booking-time"><b>{booking.slot.time}</b></div><div className="patient-initial">{booking.name.charAt(0).toUpperCase()}</div><div className="booking-person"><b>{booking.name}</b><span>{booking.slot.clinician}</span></div><StatusBadge value={booking.status} /></div>)}</div> : <Empty title="No appointments today" detail="When a patient books a time, it will appear in this schedule." />}
        </section>
        <section className="card upcoming-card"><div className="card-head"><h2>Next appointments</h2><button className="text-button" onClick={() => onNavigate('bookings')}>View all <ArrowUpRight size={14} /></button></div>
          {bookingLoading ? <LoadingLine /> : bookingError ? <Empty title="Upcoming schedule unavailable" detail="Check the MediBook connection to load appointments." /> : nextAppointments.length ? <div className="booking-list">{nextAppointments.map((booking) => <div className="booking-row" key={booking.id}><div className="booking-time"><b>{new Date(`${booking.slot.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</b><span>{booking.slot.time}</span></div><div className="patient-initial">{booking.name.charAt(0).toUpperCase()}</div><div className="booking-person"><b>{booking.name}</b><span>{booking.slot.clinician}</span></div><StatusBadge value={booking.status} /></div>)}</div> : <Empty title="No upcoming appointments" detail="New bookings from MediBook and the widget will appear here." />}
        </section>
      </div>
      <section className="card activity-card"><div className="card-head"><h2>Connected services</h2><button className="text-button" onClick={() => onNavigate('logs')}>View logs <ArrowUpRight size={14} /></button></div>
        <div className="service-row"><div><b>MediBook</b><span>{bookingLoading ? 'Checking the appointment service' : bookingError || 'Appointment service responding'}</span></div><StatusBadge value={bookingLoading ? 'Checking' : bookingError ? 'Issue' : 'Ready'} /></div>
        <div className="service-row"><div><b>Automation engine</b><span>{automationLoading ? 'Checking workflows' : automationError || (automationCount ? 'Ready for booking events' : 'No enabled workflows')}</span></div><StatusBadge value={automationLoading ? 'Checking' : automationError ? 'Issue' : automationCount ? 'Ready' : 'Paused'} /></div>
        <div className="service-row"><div><b>Webhook delivery</b><span>{deliveryLoading ? 'Checking recent deliveries' : deliveryError || `${waitingDeliveries} pending · ${failedDeliveries} failed`}</span></div><StatusBadge value={deliveryLoading ? 'Checking' : deliveryError ? 'Issue' : failedDeliveries ? 'Failed' : waitingDeliveries ? 'Pending' : 'Ready'} /></div>
      </section>
    </div>
  </>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <section className="metric-card"><div className="metric-label">{label}</div><strong>{value}</strong><span>{detail}</span></section>;
}

function Bookings({ token, refreshKey }: { token: string; refreshKey: number }) {
  const { data, error, loading, reload } = useLoad<{ bookings: Booking[] }>('bookings', token, '/medibook/bookings', refreshKey, { bookings: [] });
  const [notice, setNotice] = useState('');
  const [date, setDate] = useState(nextWeekdayDate());
  const [slots, setSlots] = useState<Array<{ id: string; time: string; clinician: string }>>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSlots = useCallback(async () => { try { const result = await api<{ slots: typeof slots }>(`/medibook/slots?date=${date}`, token); setSlots(result.slots); setSelected(result.slots[0]?.id ?? ''); } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to load slots.'); } }, [date, token]);
  useEffect(() => { void loadSlots(); }, [loadSlots]);
  async function book(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true); setNotice('');
    const correlationId = globalThis.crypto?.randomUUID?.() ?? `dashboard-${Date.now()}`;
    try {
      const result = await api<{ booking: Booking }>('/medibook/bookings', token, { method: 'POST', headers: { 'x-request-id': correlationId, 'idempotency-key': correlationId }, body: JSON.stringify({ slotId: selected, name, email, ...(phone.trim() ? { phone: phone.trim() } : {}) }) });
      setName(''); setEmail(''); setPhone(''); await Promise.all([reload(), loadSlots()]);
      const appointmentMessage = `Appointment booked for ${result.booking.slot.date} at ${result.booking.slot.time}.`;
      if (import.meta.env.DEV) {
        try {
          await api('/events/simulate', token, { method: 'POST', headers: { 'x-request-id': correlationId, 'idempotency-key': `dashboard:${result.booking.id}` }, body: JSON.stringify({ type: 'booking.created', data: { bookingId: result.booking.id, source: 'dashboard booking' } }) });
          setNotice(`${appointmentMessage} The local booking.created workflow was triggered.`);
        } catch (eventError) {
          setNotice(`${appointmentMessage} The event could not be simulated: ${eventError instanceof Error ? eventError.message : 'try it from Automations.'}`);
        }
      } else setNotice(appointmentMessage);
    }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to create booking.'); }
    finally { setBusy(false); }
  }
  const bookings = data.bookings ?? [];
  return <><PageHeading title="Bookings" description="Review patient appointments from the widget and the MediBook service." action={<span className="connection-chip"><span className={`status-dot ${loading ? 'dot-checking' : error ? 'dot-error' : ''}`} />{loading ? 'Checking MediBook…' : error ? 'MediBook unavailable' : 'MediBook responding'}</span>} /><ErrorBanner>{error}</ErrorBanner>{notice && <div className="notice-banner">{notice}</div>}
    <div className="booking-page-grid"><section className="card"><div className="card-head"><div><h2>Appointment schedule</h2></div><button className="icon-button quiet" onClick={() => void reload()} aria-label="Refresh bookings"><RefreshCw size={16} /></button></div>
      {loading ? <LoadingLine /> : bookings.length ? <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Date & time</th><th>Clinician</th><th>Status</th></tr></thead><tbody>{bookings.map((booking) => <tr key={booking.id}><td><div className="table-person"><span>{booking.name.charAt(0).toUpperCase()}</span><div><b>{booking.name}</b><small>{booking.email}</small></div></div></td><td>{booking.slot.date}<small className="table-sub">{booking.slot.time}</small></td><td>{booking.slot.clinician}</td><td><StatusBadge value={booking.status} /></td></tr>)}</tbody></table></div> : <Empty title="No appointments found" detail="Use the quick booking form or the embedded widget to create one." />}</section>
      <section className="card quick-book"><h2>Book a patient</h2><p>Use the same MediBook service used by the public widget.</p><form onSubmit={book}><label>Appointment date<input type="date" min={dateInputValue(new Date())} value={date} onChange={(e) => setDate(e.target.value)} /></label><label>Available time<select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!slots.length}>{slots.length ? slots.map((slot) => <option value={slot.id} key={slot.id}>{slot.time} · {slot.clinician}</option>) : <option>No available times</option>}</select></label><label>Patient name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Patient name" required minLength={2} /></label><label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Phone number <span className="optional-label">Optional</span><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} placeholder="Contact number" /></label><button className="primary wide" disabled={busy || !selected}>{busy ? 'Saving appointment…' : 'Create appointment'}<ArrowUpRight size={15} /></button></form><div className="small-note"><ShieldCheck size={14} /> Patient details are sent to the configured MediBook service.</div></section></div>
  </>;
}

function WidgetSetup({ token, refreshKey }: { token: string; refreshKey: number }) {
  return <><PageHeading title="Booking widget" description="Create an origin-restricted browser key and copy the single-script install snippet for your clinic website." action={import.meta.env.DEV && <a className="secondary widget-demo-link" href="http://localhost:5174" target="_blank" rel="noreferrer">Open local demo <ArrowUpRight size={14} /></a>} /><ol className="widget-onboarding"><li><b>Create a public key</b><small>Limit it to the origin where the widget will be embedded.</small></li><li><b>Install one script tag</b><small>Paste the generated snippet before your page’s closing body tag.</small></li><li><b>Verify a booking</b><small>Use the separate-origin demo or your clinic site to test the flow.</small></li></ol><WidgetKeys token={token} refreshKey={refreshKey} /></>;
}

function nextWeekdayDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
  return dateInputValue(date);
}

function dateInputValue(date: Date): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${date.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

function WidgetKeys({ token, refreshKey }: { token: string; refreshKey: number }) {
  const { data, error, loading, reload } = useLoad<{ keys: Array<{ id: string; clinicId: string; allowedOrigins: string[]; keyHint: string; enabled: boolean }> }>('widget keys', token, '/api-keys', refreshKey, { keys: [] });
  const [clinicId, setClinicId] = useState('clinic');
  const [origin, setOrigin] = useState(import.meta.env.DEV ? 'http://localhost:5174' : '');
  const [privacyUrl, setPrivacyUrl] = useState('');
  const [snippet, setSnippet] = useState('');
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  async function createKey(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice('');
    try {
      const allowedOrigin = new URL(origin).origin;
      const privacyNoticeUrl = privacyUrl.trim() ? new URL(privacyUrl.trim()) : undefined;
      if (!import.meta.env.DEV && !privacyNoticeUrl) throw new Error('Add the clinic privacy notice URL before creating a production widget key.');
      if (privacyNoticeUrl && (privacyNoticeUrl.protocol !== 'https:' || privacyNoticeUrl.username || privacyNoticeUrl.password)) throw new Error('The clinic privacy notice must use HTTPS and must not contain credentials.');
      const result = await api<{ publicKey: string }>('/api-keys', token, { method: 'POST', body: JSON.stringify({ clinicId, allowedOrigins: [allowedOrigin] }) });
      setSnippet(`<script src="${apiBaseUrl}/widget.js" data-api="${apiBaseUrl}" data-key="${result.publicKey}" data-clinic="${clinicId}"${privacyNoticeUrl ? ` data-privacy-url="${privacyNoticeUrl.href}"` : ''}></script>`);
      setSnippetCopied(false);
      setNotice('Widget key created. Copy this snippet now; the full public key is not shown again.');
      await reload();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to create a widget key.'); }
    finally { setBusy(false); }
  }
  async function toggleKey(key: { id: string; enabled: boolean }) {
    try { await api(`/api-keys/${key.id}`, token, { method: 'PATCH', body: JSON.stringify({ enabled: !key.enabled }) }); await reload(); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to update this key.'); }
  }
  async function copySnippet() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(snippet); setSnippetCopied(true);
    } catch { setNotice('Clipboard access failed; select and copy the snippet manually.'); }
  }
  return <section className="card widget-key-card"><div className="card-head"><div><h2>Booking widget keys</h2></div><span className="privacy-chip"><KeyRound size={13} /> Public keys</span></div>
    <p className="widget-key-intro">Create a browser key for a clinic website. The allowlist uses exact origins and limits browser access; the key itself is public by design.</p>
    <div className="widget-key-grid"><form onSubmit={createKey}><label>Clinic ID<input value={clinicId} onChange={(e) => setClinicId(e.target.value)} minLength={1} maxLength={100} pattern="[A-Za-z0-9_-]+" required /></label><label>Allowed site origin<input type="url" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://clinic.example" required /></label><label>Clinic privacy notice URL<input type="url" value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://clinic.example/privacy" required={!import.meta.env.DEV} /><small>Required for production widget keys; patients can open this notice from the booking form.</small></label><button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : <KeyRound size={14} />} Create widget key</button></form><div className="key-list"><div className="key-list-heading">Active and disabled keys <button className="text-button" onClick={() => void reload()}><RefreshCw size={12} /> Refresh</button></div>{loading ? <LoadingLine /> : data.keys?.length ? data.keys.map((key) => <div className="key-row" key={key.id}><div className="key-symbol"><KeyRound size={14} /></div><div className="key-meta"><b>{key.clinicId} <code>{key.keyHint}</code></b><span>{key.allowedOrigins.join(', ')}</span></div><StatusBadge value={key.enabled ? 'Enabled' : 'Disabled'} /><button className="text-button" onClick={() => void toggleKey(key)}>{key.enabled ? 'Disable' : 'Enable'}</button></div>) : <div className="empty-inline">No widget keys configured.</div>}</div></div>
    {error && <div className="key-error">{error}</div>}{notice && <div className="notice-banner key-notice">{notice}</div>}{snippet && <div className="snippet-panel"><div><b>INSTALL SNIPPET · SHOWN ONCE</b><button className="text-button" onClick={() => void copySnippet()}><Copy size={13} /> {snippetCopied ? 'Copied' : 'Copy code'}</button></div><code>{snippet}</code></div>}
  </section>;
}

function Notes({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<VisitNote | null>(null); const [redacted, setRedacted] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const { data, reload } = useLoad<{ notes: VisitNote[]; pagination?: { page: number; pages: number; total: number } }>('notes', token, `/notes?page=${historyPage}&limit=20`, refreshKey, { notes: [] });
  async function summarize(event: React.FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setNotice(''); setNote(null); setRedacted('');
    try {
      const response = await api<{ note: VisitNote; redactedText: string; pending?: boolean }>('/notes/summarize', token, { method: 'POST', headers: { 'idempotency-key': globalThis.crypto.randomUUID() }, body: JSON.stringify({ note: text }) });
      let latest = response.note;
      if (latest.status === 'pending') {
        setNotice('The summary is still processing. Checking for the completed draft…');
        for (let attempt = 0; attempt < 20 && latest.status === 'pending'; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          const next = await api<{ note: VisitNote }>(`/notes/${latest.id}`, token);
          latest = next.note;
        }
      }
      setNote(latest); setRedacted(response.redactedText || latest.redactedText);
      if (latest.status === 'pending') setNotice('This summary is still running. Check the history in a moment to see its result.');
      else setNotice('');
      await reload();
    }
    catch (reason) {
      if (reason instanceof ApiError && typeof reason.payload === 'object' && reason.payload !== null) {
        const payload = reason.payload as { note?: VisitNote; redactedText?: string };
        if (payload.note) { setNote(payload.note); setRedacted(payload.redactedText || payload.note.redactedText); await reload(); }
      }
      setError(reason instanceof Error ? reason.message : 'Unable to summarize this note.');
    }
    finally { setLoading(false); }
  }
  return <><PageHeading title="Visit notes" description="Turn clinician notes into structured SOAP drafts with best-effort PHI redaction before the LLM call." action={<div className="notes-heading-actions"><span className="privacy-chip"><ShieldCheck size={14} /> Redacted before AI</span>{import.meta.env.DEV && <button className="secondary" onClick={() => setText('A patient reports a three-day dry cough and mild fatigue. No fever or shortness of breath. Lungs are clear on exam. Assessment: likely viral upper respiratory infection. Plan: supportive care, hydration, and return if symptoms worsen.')} disabled={loading}>Load example</button>}</div>} /><ErrorBanner>{error}</ErrorBanner>{notice && <div className="notice-banner"><Activity size={14} />{notice}</div>}
    <div className="notes-layout"><section className="card note-input"><div className="card-head"><div><h2>Clinical note</h2></div><span className="char-count">{text.length.toLocaleString()} / 20,000</span></div><form onSubmit={summarize}><textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={20_000} minLength={20} aria-label="Clinical note" placeholder="Enter a visit note to create a structured draft…" required /><div className="note-actions"><span><ShieldCheck size={14} /> Raw note storage follows the server policy</span><button className="primary" disabled={loading || text.trim().length < 20}>{loading ? <><span className="spinner" /> Summarizing…</> : <><Sparkles size={15} /> Generate SOAP draft</>}</button></div></form>
      {note && <div className="redacted-panel"><div><span className="redacted-context">Text sent to the model</span><span className="redacted-tag"><Check size={12} /> REDACTED</span></div><pre>{redacted}</pre></div>}
      {note?.status === 'failed' && <div className="notice-banner danger">Summary failed: {note.error}</div>}
      {note?.summary && <div className="summary-panel"><div className="card-head"><div><h2>SOAP summary</h2></div><span className="provider-chip"><Sparkles size={13} /> {note.provider} · {note.model}</span></div><Soap title="Subjective" text={note.summary.subjective} /><Soap title="Objective" text={note.summary.objective} /><Soap title="Assessment" text={note.summary.assessment} /><Soap title="Plan" text={note.summary.plan} />{note.summary.followUps.length > 0 && <div className="soap-block"><b>Follow-ups</b><ul>{note.summary.followUps.map((item) => <li key={item}>{item}</li>)}</ul></div>}{note.summary.flags.length > 0 && <div className="flag-list">{note.summary.flags.map((item) => <span key={item}><CircleAlert size={12} />{item}</span>)}</div>}<div className="llm-meta">{note.tokensIn ?? 0} input tokens <i /> {note.tokensOut ?? 0} output tokens <i /> {note.latencyMs ?? 0} ms</div></div>}
    </section><aside className="card privacy-card"><div className="privacy-icon"><ShieldCheck size={20} /></div><h3>Redaction happens before the model call.</h3><p>Emails, phone numbers, SSN-like IDs, DOBs, MRNs, and “Patient:” name labels are masked before text is sent to an LLM provider.</p><div className="privacy-line"><Check size={15} /> Raw note not retained by default</div><div className="privacy-line"><Check size={15} /> Idempotency prevents duplicate calls</div><div className="privacy-line"><Check size={15} /> Metadata only in service logs</div><div className="disclaimer">Best-effort redaction only. This tool does not claim HIPAA compliance. Always review drafts before clinical use.</div></aside></div>
    <section className="card history-card"><div className="card-head"><div><h2>Summarization history</h2></div><span className="subtle-count">{data.pagination?.total ?? data.notes?.length ?? 0} notes</span></div>{data.notes?.length ? <><div className="table-wrap"><table><thead><tr><th>Created</th><th>Status</th><th>Model</th><th>Correlation ID</th></tr></thead><tbody>{data.notes.map((item) => <tr key={item.id}><td>{dateTime(item.createdAt)}</td><td><StatusBadge value={item.status} /></td><td>{item.model ?? '–'}</td><td className="mono small-cell">{item.correlationId.slice(0, 14)}…</td></tr>)}</tbody></table></div><div className="log-pagination"><span>Page {data.pagination?.page ?? historyPage} of {data.pagination?.pages ?? 1}</span><div><button className="secondary" onClick={() => setHistoryPage((page) => Math.max(1, page - 1))} disabled={historyPage <= 1}>Previous</button><button className="secondary" onClick={() => setHistoryPage((page) => Math.min(data.pagination?.pages ?? 1, page + 1))} disabled={historyPage >= (data.pagination?.pages ?? 1)}>Next</button></div></div></> : <Empty title="No notes summarized" detail="Your saved summary history will show here." />}</section>
  </>;
}

function Soap({ title, text }: { title: string; text: string }) { return <div className="soap-block"><b>{title}</b><p>{text}</p></div>; }

function Automations({ token, refreshKey }: { token: string; refreshKey: number }) {
  const { data, error, loading, reload } = useLoad<{ automations: Automation[] }>('automations', token, '/automations', refreshKey, { automations: [] });
  const templatesState = useLoad<{ templates: PromptTemplate[] }>('prompt templates', token, '/templates', refreshKey, { templates: [] });
  const { data: llmLogData, error: llmLogError, reload: reloadLlmLogs } = useLoad<{ items: LogEntry[]; total: number }>('LLM metrics', token, '/logs?type=llm&limit=100&page=1', refreshKey, { items: [], total: 0 });
  const [running, setRunning] = useState('');
  const [notice, setNotice] = useState('');
  const [runRevision, setRunRevision] = useState(0);
  const [showAutomationForm, setShowAutomationForm] = useState(false);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [automationName, setAutomationName] = useState('Pre-visit summary');
  const [triggerEvent, setTriggerEvent] = useState('booking.created');
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('Clinic event summary');
  const [templateBody, setTemplateBody] = useState('Summarize this clinic event as a concise structured note. Use only the supplied information and do not invent clinical facts.');
  const [templateActive, setTemplateActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const templates = useMemo(() => templatesState.data.templates ?? [], [templatesState.data.templates]);
  const llmLogsByCorrelation = useMemo(() => Object.fromEntries((llmLogData.items ?? []).map((item) => [item.correlationId, item])), [llmLogData.items]);

  useEffect(() => {
    if (!templateId && templates.length) setTemplateId(templates.find((item) => item.active)?.id ?? templates[0].id);
  }, [templateId, templates]);

  async function simulate() {
    setRunning('simulate'); setNotice('');
    try {
      const result = await api<{ correlationId: string }>('/events/simulate', token, { method: 'POST', body: JSON.stringify({ type: 'booking.created', data: { bookingId: `demo-${globalThis.crypto.randomUUID()}`, source: 'dashboard simulation' } }) });
      setNotice(`booking.created processed · correlation ${result.correlationId}`);
      await Promise.all([reload(), templatesState.reload(), reloadLlmLogs()]); setRunRevision((value) => value + 1);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Simulation failed.'); }
    finally { setRunning(''); }
  }

  async function run(automation: Automation) {
    setRunning(automation.id); setNotice('');
    try {
      const result = await api<{ runs: Array<{ status: string }> }>(`/automations/${automation.id}/run`, token, { method: 'POST', body: JSON.stringify({ source: 'manual dashboard run' }) });
      setNotice(`Automation finished with ${result.runs[0]?.status ?? 'no run'} status.`);
      await reloadLlmLogs();
      setRunRevision((value) => value + 1);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Run failed.'); }
    finally { setRunning(''); }
  }

  async function toggleAutomation(item: Automation) {
    setSaving(true); setNotice('');
    try {
      await api(`/automations/${item.id}`, token, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) });
      setNotice(`${item.name} ${item.enabled ? 'paused' : 'enabled'}.`); await reload();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to update automation.'); }
    finally { setSaving(false); }
  }

  async function createTemplate(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setNotice('');
    try {
      const result = await api<{ template: PromptTemplate }>('/templates', token, { method: 'POST', body: JSON.stringify({ name: templateName, body: templateBody, active: templateActive }) });
      setTemplateId(result.template.id); setNotice(`Prompt template v${result.template.version} created${templateActive ? ' and activated' : ''}.`);
      setShowTemplateForm(false); await templatesState.reload();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to save prompt template.'); }
    finally { setSaving(false); }
  }

  async function createAutomation(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setNotice('');
    try {
      await api('/automations', token, { method: 'POST', body: JSON.stringify({ name: automationName, triggerEvent, templateId, enabled: true }) });
      setNotice('Automation created and enabled.'); setShowAutomationForm(false); await reload();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to create automation.'); }
    finally { setSaving(false); }
  }

  return <>
    <PageHeading title="Automations" description="Create prompt-backed workflows, run them on demand, or connect them to booking events." action={import.meta.env.DEV && <button className="primary" onClick={simulate} disabled={running !== ''}>{running === 'simulate' ? <span className="spinner" /> : <Sparkles size={15} />} Simulate booking.created</button>} />
    <ErrorBanner>{error || templatesState.error || llmLogError}</ErrorBanner>{notice && <div className="notice-banner"><Activity size={14} />{notice}</div>}
    <div className="workflow-toolbar"><div><b>{data.automations?.length ?? 0} workflows</b><span>{templates.length} prompt templates</span>{!templates.length && <small>Create a prompt template first to enable workflow setup.</small>}</div><div><button className="secondary" onClick={() => { setShowTemplateForm((value) => !value); setShowAutomationForm(false); }}><Plus size={14} /> New template</button><button className="primary" onClick={() => { setShowAutomationForm((value) => !value); setShowTemplateForm(false); }} disabled={!templates.length}><Plus size={14} /> New automation</button></div></div>
    {showTemplateForm && <section className="card workflow-form-card"><div className="card-head"><div><h2>Create prompt template</h2></div><button className="icon-button" onClick={() => setShowTemplateForm(false)} aria-label="Close template form"><X size={17} /></button></div><form className="workflow-form" onSubmit={createTemplate}><label>Template name<input value={templateName} onChange={(event) => setTemplateName(event.target.value)} minLength={2} maxLength={100} required /></label><label>Prompt instructions<textarea value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} minLength={10} maxLength={5000} required /></label><label className="check-label"><input type="checkbox" checked={templateActive} onChange={(event) => setTemplateActive(event.target.checked)} /> Use this as the active summarization template</label><div className="form-actions"><button type="button" className="secondary" onClick={() => setShowTemplateForm(false)}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save template'}</button></div></form></section>}
    {showAutomationForm && <section className="card workflow-form-card"><div className="card-head"><div><h2>Create automation</h2></div><button className="icon-button" onClick={() => setShowAutomationForm(false)} aria-label="Close automation form"><X size={17} /></button></div><form className="workflow-form workflow-form-inline" onSubmit={createAutomation}><label>Automation name<input value={automationName} onChange={(event) => setAutomationName(event.target.value)} minLength={2} maxLength={100} required /></label><label>Trigger event<input value={triggerEvent} onChange={(event) => setTriggerEvent(event.target.value)} minLength={3} maxLength={100} required /></label><label>Prompt template<select value={templateId} onChange={(event) => setTemplateId(event.target.value)} required>{templates.map((item) => <option value={item.id} key={item.id}>{item.name}{item.active ? ' · active' : ''}</option>)}</select></label><div className="form-actions"><button type="button" className="secondary" onClick={() => setShowAutomationForm(false)}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Creating…' : 'Create automation'}</button></div></form></section>}
    {templates.length > 0 && <section className="card template-library"><div className="card-head"><div><h2>Templates</h2></div><span className="subtle-count">Used by notes and automations</span></div><div className="template-list">{templates.map((item) => <div className="template-row" key={item.id}><div><b>{item.name}</b><span>Version {item.version} · {item.body.slice(0, 140)}{item.body.length > 140 ? '…' : ''}</span></div>{item.active ? <StatusBadge value="Active" /> : <span className="template-inactive">Available</span>}</div>)}</div></section>}
    <div className="automation-grid">{loading ? <div className="card"><LoadingLine /></div> : data.automations?.length ? data.automations.map((item) => <AutomationCard key={item.id} item={item} token={token} llmLogs={llmLogsByCorrelation} running={running === item.id} saving={saving} refreshKey={refreshKey + runRevision} onRun={() => run(item)} onToggle={() => void toggleAutomation(item)} />) : <div className="card"><Empty title="No automations yet" detail={templates.length ? 'Create your first workflow to respond to events.' : 'Create a prompt template first, then connect it to an event.'} /></div>}</div>
    <section className="card event-card"><div className="event-symbol"><Activity size={18} /></div><div><h2>booking.created</h2><p>Widget bookings are verified against MediBook before enabled automations run. One correlation ID follows the booking, service calls, LLM request, and webhook delivery.</p></div><span className="event-ready"><i /> LISTENING</span></section>
  </>;
}

type PromptTemplate = { id: string; name: string; body: string; active: boolean; version: number; createdAt: string };

function AutomationCard({ item, token, llmLogs, running, saving, refreshKey, onRun, onToggle }: { item: Automation; token: string; llmLogs: Record<string, LogEntry>; running: boolean; saving: boolean; refreshKey: number; onRun: () => void; onToggle: () => void }) {
  const [runs, setRuns] = useState<Array<{ id: string; status: string; createdAt: string; correlationId: string }>>([]);
  useEffect(() => { let active = true; void api<{ runs: typeof runs }>(`/automations/${item.id}/runs`, token).then((result) => { if (active) setRuns(result.runs.slice(0, 3)); }).catch(() => {}); return () => { active = false; }; }, [item.id, token, refreshKey]);
  const latestRun = runs[0];
  const latestMetrics = latestRun ? llmLogs[latestRun.correlationId] : undefined;
  return <section className="card automation-card"><div className="automation-card-head"><div className="automation-icon"><Sparkles size={17} /></div><StatusBadge value={item.enabled ? 'Active' : 'Paused'} /><button className="text-button automation-toggle" onClick={onToggle} disabled={saving}>{item.enabled ? 'Pause' : 'Enable'}</button></div><h2>{item.name}</h2><div className="trigger-label"><span>Trigger</span><code>{item.triggerEvent}</code></div><p>Uses the linked prompt template to generate a structured result for each matching event.</p><button className="secondary run-button" onClick={onRun} disabled={running || !item.enabled}>{running ? <span className="spinner" /> : <Send size={14} />} Run now <ArrowUpRight size={13} /></button><div className="run-history"><div className="run-history-title">Recent runs</div>{runs.length ? runs.map((run) => <div className="run-item" key={run.id}><span className={`run-check ${run.status}`} aria-label={run.status}><Check size={11} /></span><span>{dateTime(run.createdAt)}</span><code title={run.correlationId}>{run.correlationId.slice(0, 8)}</code></div>) : <div className="empty-inline">No runs yet</div>}{latestRun && <div className="run-metrics"><StatusBadge value={latestRun.status} /><span>{latestMetrics ? `${latestMetrics.tokensIn ?? '–'} in · ${latestMetrics.tokensOut ?? '–'} out · ${latestMetrics.latencyMs ?? '–'} ms` : 'Usage details available in correlated logs'}</span></div>}</div></section>;
}

function Webhooks({ token, refreshKey }: { token: string; refreshKey: number }) {
  const { data: endpointData, error, loading, reload: reloadEndpoints } = useLoad<{ endpoints: Endpoint[] }>('endpoints', token, '/webhooks/endpoints', refreshKey, { endpoints: [] });
  const [deliveryPage, setDeliveryPage] = useState(1);
  const { data: deliveryData, loading: deliveriesLoading, reload: reloadDeliveries } = useLoad<{ deliveries: Delivery[]; pagination?: { page: number; pages: number; total: number } }>('deliveries', token, `/webhooks/deliveries?page=${deliveryPage}&limit=25`, refreshKey, { deliveries: [] });
  const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [newSecret, setNewSecret] = useState('');
  const [secretCopied, setSecretCopied] = useState(false); const [endpointUrl, setEndpointUrl] = useState(''); const [receiverMode, setReceiverMode] = useState<Endpoint['mode']>('500');
  const [selectedEndpointId, setSelectedEndpointId] = useState(''); const [showEndpointForm, setShowEndpointForm] = useState(false);
  const endpoints = useMemo(() => endpointData.endpoints ?? [], [endpointData.endpoints]); const deliveries = deliveryData.deliveries ?? [];
  useEffect(() => { if (!endpoints.some((item) => item.id === selectedEndpointId)) setSelectedEndpointId(endpoints[0]?.id ?? ''); }, [endpoints, selectedEndpointId]);
  const endpoint = endpoints.find((item) => item.id === selectedEndpointId);
  const sandboxEndpoint = Boolean(endpoint?.url.includes('/sandbox/receiver/'));
  useEffect(() => { const timer = window.setInterval(() => { void reloadDeliveries(); }, 10_000); return () => window.clearInterval(timer); }, [reloadDeliveries]);
  async function createEndpoint(event: React.FormEvent) { event.preventDefault(); setBusy(true); setNotice(''); try { const body = endpointUrl.trim() ? { url: endpointUrl.trim(), mode: receiverMode } : { mode: receiverMode }; const result = await api<{ endpoint: Endpoint; secret: string }>('/webhooks/endpoints', token, { method: 'POST', body: JSON.stringify(body) }); setNewSecret(result.secret); setSecretCopied(false); setNotice('Endpoint created. Copy the signing secret now; it is only shown once.'); setEndpointUrl(''); setShowEndpointForm(false); await reloadEndpoints(); setSelectedEndpointId(result.endpoint.id); } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to create endpoint.'); } finally { setBusy(false); } }
  async function sendTest() { if (!endpoint?.enabled) return; setBusy(true); setNotice(''); try { await api('/webhooks/send-test', token, { method: 'POST', body: JSON.stringify({ endpointId: endpoint.id }) }); setNotice('Test delivery queued. The delivery timeline will update as attempts complete.'); await reloadDeliveries(); } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to queue delivery.'); } finally { setBusy(false); } }
  async function setMode(mode: Endpoint['mode']) { if (!endpoint) return; setBusy(true); try { await api(`/webhooks/endpoints/${endpoint.id}`, token, { method: 'PATCH', body: JSON.stringify({ mode }) }); setNotice(`Sandbox receiver switched to ${mode}.`); await reloadEndpoints(); } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to change receiver mode.'); } finally { setBusy(false); } }
  async function toggleEndpoint() { if (!endpoint) return; setBusy(true); try { await api(`/webhooks/endpoints/${endpoint.id}`, token, { method: 'PATCH', body: JSON.stringify({ enabled: !endpoint.enabled }) }); setNotice(`Endpoint ${endpoint.enabled ? 'disabled' : 'enabled'}.`); await reloadEndpoints(); } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to update endpoint.'); } finally { setBusy(false); } }
  async function copySecret() { if (!newSecret) return; try { await navigator.clipboard.writeText(newSecret); setSecretCopied(true); } catch { setNotice('Clipboard access failed; select and copy the signing secret manually.'); } }
  async function replay(delivery: Delivery) { setBusy(true); try { await api(`/webhooks/deliveries/${delivery.id}/replay`, token, { method: 'POST' }); setNotice(`Replay queued for ${delivery.id.slice(0, 8)}.`); await reloadDeliveries(); } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Unable to replay delivery.'); } finally { setBusy(false); } }
  return <><PageHeading title="Webhooks" description="Configure signed destinations, inspect delivery attempts, and replay events when a receiver recovers." action={<div className="webhook-heading-actions"><button className="secondary" onClick={() => setShowEndpointForm((value) => !value)}><Plus size={14} /> Add endpoint</button><button className="primary" onClick={sendTest} disabled={busy || !endpoint?.enabled}>{busy ? <span className="spinner" /> : <Send size={15} />} Send test event</button></div>} /><ErrorBanner>{error}</ErrorBanner>{notice && <div className="notice-banner"><Activity size={14} />{notice}</div>}{newSecret && <div className="secret-banner"><KeyRound size={16} /><div><b>Save this endpoint signing secret</b><code>{newSecret}</code><small>It is stored encrypted for request signing and will not be shown again.</small></div><button className="secondary copy-secret" onClick={() => void copySecret()}>{secretCopied ? <CheckCircle2 size={14} /> : <Copy size={14} />}{secretCopied ? 'Copied' : 'Copy secret'}</button></div>}
    {showEndpointForm && <section className="card endpoint-create"><div className="card-head"><div><h2>Add webhook endpoint</h2></div><button className="icon-button" onClick={() => setShowEndpointForm(false)} aria-label="Close endpoint form"><X size={17} /></button></div><form className="endpoint-create-form" onSubmit={createEndpoint}><label>HTTPS endpoint URL<input type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://your-service.example/webhooks/mediassist" /></label><div className="endpoint-create-options"><span>{endpointUrl ? 'External destinations are validated before any test is sent.' : 'Leave blank to create a local sandbox receiver.'}</span>{!endpointUrl && <label>Sandbox response<select value={receiverMode} onChange={(event) => setReceiverMode(event.target.value as Endpoint['mode'])}><option value="500">500 · retry</option><option value="ok">200 · success</option><option value="timeout">Timeout</option><option value="slow">Slow response</option><option value="badsig">Reject signature</option></select></label>}</div><div className="form-actions"><button type="button" className="secondary" onClick={() => setShowEndpointForm(false)}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create endpoint'}</button></div></form></section>}
    <div className="webhook-top-grid"><section className="card endpoint-card"><div className="card-head"><div><h2>Endpoint settings</h2></div>{endpoint && <StatusBadge value={endpoint.enabled ? 'Enabled' : 'Disabled'} />}</div>{loading ? <LoadingLine /> : endpoint ? <><div className="endpoint-selector"><label>Configured endpoint<select value={endpoint.id} onChange={(event) => setSelectedEndpointId(event.target.value)}>{endpoints.map((item) => <option value={item.id} key={item.id}>{item.url.replace(/^https?:\/\//, '').slice(0, 58)}{item.enabled ? '' : ' · disabled'}</option>)}</select></label><button className="text-button" onClick={() => void toggleEndpoint()} disabled={busy}>{endpoint.enabled ? 'Disable endpoint' : 'Enable endpoint'}</button></div><div className="endpoint-url"><span>POST</span><code title={endpoint.url}>{endpoint.url}</code></div>{sandboxEndpoint ? <div className="endpoint-controls"><label>Sandbox receiver mode<select value={endpoint.mode} onChange={(e) => void setMode(e.target.value as Endpoint['mode'])} disabled={busy}><option value="500">500 · Server error</option><option value="ok">200 · Success</option><option value="timeout">Timeout</option><option value="slow">Slow response</option><option value="badsig">Reject signature</option></select></label><div className="mode-explainer">{endpoint.mode === '500' ? 'The receiver returns a 500 to exercise retry scheduling.' : endpoint.mode === 'ok' ? 'The receiver verifies the HMAC signature and responds successfully.' : endpoint.mode === 'badsig' ? 'The receiver intentionally rejects each signature.' : endpoint.mode === 'timeout' ? 'The receiver waits past the sender timeout.' : 'The receiver delays before returning success.'}</div></div> : <div className="mode-explainer external-endpoint-note"><ShieldCheck size={14} /> External HTTPS destination · delivery requests use signed payloads.</div>}</> : <div className="endpoint-empty"><Webhook size={22} /><b>No endpoint configured</b><span>Add a public HTTPS destination or create a local sandbox receiver.</span><button className="secondary" onClick={() => setShowEndpointForm(true)}>Add endpoint</button></div>}</section>
      <section className="card retry-card"><div className="retry-graphic"><div className="retry-ring"><RefreshCw size={19} /></div><span>5</span></div><h2>Backoff with replay</h2><p>Retries persist in the database and resume after a restart.</p><div className="retry-steps"><span>5s</span><i /><span>30s</span><i /><span>2m</span><i /><span>10m</span></div><small>Maximum 5 attempts · HMAC-SHA256 · 5-minute timestamp window</small></section></div>
    <section className="card delivery-card"><div className="card-head"><div><h2>Webhook deliveries</h2></div><div className="delivery-actions"><span className="subtle-count">{deliveryData.pagination?.total ?? deliveries.length} total · auto-refreshes every 10 seconds</span><button className="icon-button quiet" onClick={() => void reloadDeliveries()} aria-label="Refresh deliveries"><RefreshCw size={16} /></button></div></div>{deliveriesLoading ? <LoadingLine /> : deliveries.length ? <><div className="table-wrap"><table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Last update</th><th>Correlation</th><th /></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}><td><code>{delivery.eventType}</code></td><td><StatusBadge value={delivery.status} /></td><td><span className="attempt-count">{delivery.attempts} / 5</span>{delivery.lastError && <small className="table-sub error-text">{delivery.lastError}</small>}</td><td>{dateTime(delivery.updatedAt || delivery.createdAt)}{delivery.nextAttemptAt && delivery.status === 'pending' && <small className="table-sub">Next retry {dateTime(delivery.nextAttemptAt)}</small>}</td><td><button className="link-code" title={delivery.correlationId} onClick={() => navigator.clipboard?.writeText(delivery.correlationId)}>{delivery.correlationId.slice(0, 12)}…</button></td><td><button className="text-button" onClick={() => void replay(delivery)} disabled={busy}><RefreshCw size={13} /> Replay</button></td></tr>)}</tbody></table></div><div className="log-pagination"><span>Page {deliveryData.pagination?.page ?? deliveryPage} of {deliveryData.pagination?.pages ?? 1}</span><div><button className="secondary" onClick={() => setDeliveryPage((page) => Math.max(1, page - 1))} disabled={deliveryPage <= 1 || deliveriesLoading}>Previous</button><button className="secondary" onClick={() => setDeliveryPage((page) => Math.min(deliveryData.pagination?.pages ?? 1, page + 1))} disabled={deliveryPage >= (deliveryData.pagination?.pages ?? 1) || deliveriesLoading}>Next</button></div></div></> : <Empty title="No deliveries yet" detail="Send a test event or trigger a booking automation." />}</section>
  </>;
}

function Logs({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [type, setType] = useState(''); const [status, setStatus] = useState(''); const [correlationId, setCorrelationId] = useState(''); const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState(''); const [toDate, setToDate] = useState(''); const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ items: LogEntry[]; total: number }>({ items: [], total: 0 }); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [selected, setSelected] = useState<LogEntry | null>(null);
  const [storageLabel, setStorageLabel] = useState('Local JSONL');
  useEffect(() => { void api<{ logs: { mode: string } }>('/health', token).then(({ logs }) => setStorageLabel(logs.mode === 'mongodb' ? 'MongoDB TTL · 14 days' : 'Local JSONL file')).catch(() => {}); }, [token, refreshKey]);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const params = new URLSearchParams({ page: String(page), limit: '100' }); if (type) params.set('type', type); if (status) params.set('status', status); if (correlationId) params.set('correlationId', correlationId.trim()); if (fromDate) params.set('from', new Date(`${fromDate}T00:00:00`).toISOString()); if (toDate) params.set('to', new Date(`${toDate}T23:59:59.999`).toISOString()); setResult(await api<{ items: LogEntry[]; total: number }>(`/logs?${params}`, token)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load logs.'); } finally { setLoading(false); } }, [token, type, status, correlationId, fromDate, toDate, page]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { setPage(1); }, [type, status, correlationId, fromDate, toDate]);
  const visible = result.items.filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(result.total / 100));
  const firstResult = result.total ? (page - 1) * 100 + 1 : 0;
  const lastResult = Math.min(page * 100, result.total);
  return <><PageHeading title="Log viewer" description="Follow one correlation ID across requests, MediBook, LLM calls, events, and webhook attempts." action={<span className="log-mode"><span className="status-dot" /> {storageLabel}</span>} /><ErrorBanner>{error}</ErrorBanner>
    <section className="card log-filters"><label className="search-field"><span>⌕</span><input placeholder="Filter this page by message or ID…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label>Type<select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option><option value="request">Requests</option><option value="service_call">Service calls</option><option value="llm">LLM calls</option><option value="event">Events</option><option value="webhook_attempt">Webhook attempts</option></select></label><label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All status</option><option value="completed">Completed</option><option value="received">Received</option><option value="delivered">Delivered</option><option value="failed">Failed</option><option value="retry">Retry</option><option value="200">200</option><option value="500">500</option></select></label><label className="correlation-filter">Correlation ID<input placeholder="Paste request ID" value={correlationId} onChange={(e) => setCorrelationId(e.target.value)} /></label><label className="date-filter">From<input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} /></label><label className="date-filter">To<input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} /></label><button className="secondary filter-reset" onClick={() => { setType(''); setStatus(''); setCorrelationId(''); setQuery(''); setFromDate(''); setToDate(''); setPage(1); }}>Reset</button></section>
    <section className="card timeline-card"><div className="card-head"><div><h2>{correlationId ? <>Correlation <code className="inline-code">{correlationId}</code></> : 'Latest activity'}</h2></div><div className="timeline-count">{result.total} events <button className="icon-button quiet" onClick={() => void load()} aria-label="Refresh logs"><RefreshCw size={15} /></button></div></div>
      {loading ? <LoadingLine /> : visible.length ? <div className="timeline-table"><div className="timeline-head"><span>Type</span><span>Event</span><span>Status</span><span>Time</span><span>Correlation ID</span></div>{visible.map((item, index) => {
        const eventName = String(item.method ?? item.eventType ?? item.target ?? item.provider ?? item.path ?? 'Service event');
        const detailParts = [item.url ?? item.path ?? item.model, item.durationMs ? `${item.durationMs}ms` : null].filter(Boolean);
        return <button className="timeline-row" key={item.id ?? `${item.correlationId}-${item.ts}-${index}`} onClick={() => setSelected(item)}><span className={`timeline-type type-${item.type}`}><TypeIcon type={item.type} />{item.type.replace('_', ' ')}</span><span className="timeline-event"><b>{eventName}</b><small>{detailParts.join(' · ') || 'Trace event'}</small></span><span><StatusBadge value={String(item.status ?? 'logged')} /></span><span className="time-cell">{dateTime(item.ts)}</span><span className="mono correlation-cell">{item.correlationId.slice(0, 16)}…</span></button>;
      })}</div> : <Empty title="No matching logs" detail="Try another filter or generate a booking flow to create a trace." />}
      <div className="log-pagination"><span>Showing {firstResult}–{lastResult} of {result.total} events{query && ` · ${visible.length} match this page`}</span><div><button className="secondary" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || loading}>Previous</button><span>Page {page} of {pageCount}</span><button className="secondary" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount || loading}>Next</button></div></div>
    </section>
    {selected && <div className="drawer-backdrop" onClick={() => setSelected(null)}><aside className="log-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><h2>{selected.type.replace('_', ' ')}</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close detail"><X size={18} /></button></div><div className="drawer-meta"><span>Correlation ID</span><button className="link-code" onClick={() => setCorrelationId(selected.correlationId)}>{selected.correlationId}</button><span>Timestamp</span><b>{new Date(selected.ts).toLocaleString()}</b></div><pre className="log-json">{JSON.stringify(selected, null, 2)}</pre></aside></div>}
  </>;
}

function TypeIcon({ type }: { type: string }) { const Icon = type === 'llm' ? Sparkles : type === 'webhook_attempt' ? Webhook : type === 'service_call' ? ArrowUpRight : type === 'request' ? Activity : CalendarDays; return <Icon size={14} />; }

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const token = '';
  const signOut = useCallback(() => {
    void api('/auth/logout', null, { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }, []);
  useEffect(() => {
    void api<{ user: User }>('/auth/me').then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setChecking(false));
  }, []);
  const handleLogin = (nextUser: User) => setUser(nextUser);
  const handleSessionChanged = (nextUser: User) => setUser(nextUser);
  if (checking) return <div className="full-loader"><div className="brand-mark"><Stethoscope size={19} /></div><span>Opening your workspace…</span></div>;
  if (!user) return <Login onLogin={handleLogin} />;
  return <Shell token={token} user={user} onLogout={signOut} onSessionChanged={handleSessionChanged} />;
}
