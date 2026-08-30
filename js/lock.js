/* =========================================================
   lock.js · App 鎖(PIN 碼 + 生物辨識)
   ---------------------------------------------------------
   這是「畫面鎖」,防止別人隨手拿起手機看到你的薪水數字,
   設定只存在這台裝置(localStorage),換手機要重設。

   PIN 用 SHA-256 加鹽雜湊後才儲存,不存明碼。
   生物辨識走 WebAuthn platform authenticator(Face ID / 指紋),
   不支援的裝置會自動隱藏該選項,只用 PIN。
   ========================================================= */

const LS_LOCK = "tc_lock";     // { enabled, salt, hash, credId }

const get = () => { try { return JSON.parse(localStorage.getItem(LS_LOCK)) || {}; } catch { return {}; } };
const set = (v) => { try { localStorage.setItem(LS_LOCK, JSON.stringify(v)); } catch {} };

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(salt + ":" + pin);
  return b64(await crypto.subtle.digest("SHA-256", data));
}

export const isEnabled = () => !!get().enabled;
export const hasBiometric = () => !!get().credId;

/** 這台裝置是否支援生物辨識(Face ID / 指紋) */
export async function biometricAvailable() {
  if (!window.PublicKeyCredential || !window.isSecureContext) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

/** 設定 PIN 並啟用鎖定 */
export async function enable(pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  set({ enabled: true, salt, hash: await hashPin(pin, salt) });
}

export function disable() {
  set({});
}

export async function verifyPin(pin) {
  const s = get();
  if (!s.enabled || !s.salt) return false;
  return (await hashPin(pin, s.salt)) === s.hash;
}

/* ---------- 生物辨識 ---------- */
export async function registerBiometric(username = "timecard") {
  const s = get();
  if (!s.enabled) throw new Error("請先設定 PIN 碼");
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "打卡日記", id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: username,
        displayName: username
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000,
      attestation: "none"
    }
  });
  if (!cred) throw new Error("設定失敗");
  set({ ...s, credId: b64(cred.rawId) });
}

export function removeBiometric() {
  const s = get();
  delete s.credId;
  set(s);
}

/** 用生物辨識解鎖,成功回傳 true */
export async function verifyBiometric() {
  const s = get();
  if (!s.credId) return false;
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: unb64(s.credId) }],
      userVerification: "required",
      timeout: 60000
    }
  });
  return !!assertion;
}
