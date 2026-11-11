'use client';

import { createClient } from '@supabase/supabase-js';
import { useEffect, useMemo, useState } from 'react';
import { KnowledgeEditor, type Membership } from '@/modules/admin/knowledge-editor';
import '../dashboard.css';

type AuthConfig = { url: string; key: string } | null;
type MetaConfig = { appId: string; configurationId: string };
type FacebookLoginResponse = { status?: string; authResponse?: { code?: string } };
type EmbeddedSignupEvent = {
  type?: string;
  event?: string;
  data?: { error_message?: string };
};

declare global {
  interface Window {
    FB?: {
      init: (options: { appId: string; cookie: boolean; xfbml: boolean; version: string }) => void;
      login: (
        callback: (response: FacebookLoginResponse) => void,
        options: {
          config_id: string;
          response_type: 'code';
          override_default_response_type: true;
          extras: {
            setup: Record<string, never>;
            featureType: 'whatsapp_business_app_onboarding';
            sessionInfoVersion: '3';
          };
        },
      ) => void;
    };
  }
}

function parseEvent(value: unknown): EmbeddedSignupEvent | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as EmbeddedSignupEvent;
  } catch {
    return null;
  }
}

export function WhatsAppOnboarding({ authConfig, metaConfig }: { authConfig: AuthConfig; metaConfig: MetaConfig }) {
  const db = useMemo(() => authConfig ? createClient(authConfig.url, authConfig.key) : null, [authConfig]);
  const editor = useMemo(() => db ? new KnowledgeEditor(db) : null, [db]);
  const [checking, setChecking] = useState(!!db);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [sdkReady, setSdkReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready to authorize IRAM coexistence.');
  const [error, setError] = useState('');
  const configured = /^\d+$/.test(metaConfig.appId) && /^\d+$/.test(metaConfig.configurationId);
  const canManage = memberships.some(row => ['owner', 'admin'].includes(row.role));

  useEffect(() => {
    if (!db || !editor) return;
    let active = true;
    void db.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (!data.session) { setChecking(false); return; }
      try { setMemberships(await editor.memberships()); }
      catch { setError('Could not verify your workspace access.'); }
      finally { if (active) setChecking(false); }
    }).catch(() => { if (active) { setError('Could not verify your session.'); setChecking(false); } });
    return () => { active = false; };
  }, [db, editor]);

  useEffect(() => {
    if (!configured || !canManage) return;
    const initialize = () => {
      if (!window.FB) return;
      window.FB.init({ appId: metaConfig.appId, cookie: true, xfbml: false, version: 'v26.0' });
      setSdkReady(true);
    };
    const existing = document.getElementById('facebook-jssdk');
    if (existing) { initialize(); return; }
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.onload = initialize;
    script.onerror = () => setError('Meta setup could not load. Refresh and try again.');
    document.head.appendChild(script);
  }, [canManage, configured, metaConfig.appId]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      let origin: URL;
      try { origin = new URL(event.origin); } catch { return; }
      if (origin.protocol !== 'https:' || (origin.hostname !== 'facebook.com' && !origin.hostname.endsWith('.facebook.com'))) return;
      const message = parseEvent(event.data);
      if (message?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (message.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || message.event === 'FINISH') {
        setBusy(false); setError(''); setStatus('Meta confirmed the IRAM coexistence connection.');
      } else if (message.event === 'ERROR') {
        setBusy(false); setError(message.data?.error_message || 'Meta could not complete the connection.');
      } else if (message.event === 'CANCEL') {
        setBusy(false); setStatus('Setup was cancelled before it changed the connection.');
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  function launch() {
    if (!window.FB || !sdkReady || busy) return;
    setBusy(true); setError('');
    setStatus('Complete the steps in Meta’s secure window. Choose the existing IRAM business and number.');
    window.FB.login(response => {
      if (response.status === 'connected' && response.authResponse?.code) {
        setStatus('Meta authorization received. Waiting for coexistence confirmation…');
      } else {
        setBusy(false); setStatus('Setup was not completed. No WhatsApp connection was changed.');
      }
    }, {
      config_id: metaConfig.configurationId,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    });
  }

  return <main className="onboarding-page">
    <section className="onboarding-card">
      <div className="eyebrow">IRAM WHATSAPP SETUP</div>
      <h1>Connect the existing Business app number</h1>
      <p className="intro">This launches Meta’s official coexistence flow. It keeps the WhatsApp Business app, current number, chats and groups in place.</p>
      <div className="guidance"><span className="guidance-icon" aria-hidden="true">i</span><div><strong>Choose the existing IRAM assets.</strong><p>Do not create a new WhatsApp account or number. If Meta offers migration, disconnection or deregistration, close the window.</p></div></div>
      {checking ? <p role="status">Checking your access…</p> : !db ? <p className="error">Dashboard authentication is not configured.</p> : !memberships.length ? <p className="error">Sign in to the dashboard first.</p> : !canManage ? <p className="error">Owner or admin access is required.</p> : !configured ? <p className="error">The Meta onboarding configuration is not ready.</p> : <>
        <button className="primary" disabled={!sdkReady || busy} onClick={launch}>{busy ? 'Meta setup in progress…' : sdkReady ? 'Start IRAM coexistence setup' : 'Loading Meta setup…'}</button>
        <p role="status" className="notice">{status}</p>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <p><a href="/dashboard/inbox">Return to Inbox</a></p>
    </section>
  </main>;
}
