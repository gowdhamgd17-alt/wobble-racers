// Voice chat for online rooms. Audio goes straight between browsers (WebRTC,
// Opus at a low bitrate); the game server only relays the connection set-up
// messages. Every player who joins voice connects to every other player who
// has joined voice (a small mesh, fine for room sizes up to 15 at ~24 kbps).
//
//  - push-to-talk (hold V / the mic button) or open mic, from Settings
//  - mute any player, voice volume, "who is talking" indicators
//  - Battleground: proximity voice (near cars loud, far cars quiet)

import { MSG, type RtcSignal } from '@wobble/shared';
import { net } from './Net';
import { settingsStore } from '../state/store';
import { audio } from '../audio/Audio';

type Peer = {
  id: string;
  pc: RTCPeerConnection;
  initiator: boolean;
  pendingIce: RTCIceCandidateInit[];
  el: HTMLAudioElement | null;
  src: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  retryT: number;
};

export type VoiceStatus = 'off' | 'connecting' | 'on' | 'listen-only' | 'unsupported';

const ICE_SERVERS: RTCIceServer[] = (() => {
  const list: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  // Optional relay for players behind strict networks (set at build time).
  const turn = (import.meta.env.VITE_TURN_URL as string | undefined)?.trim();
  if (turn) list.push({ urls: turn.split(',').map((u) => u.trim()), username: import.meta.env.VITE_TURN_USER as string, credential: import.meta.env.VITE_TURN_PASS as string });
  return list;
})();

/** Ask Opus for low-bitrate mono speech with silence suppression and loss protection. */
function tuneSdp(sdp: string) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (line, pt, params: string) => {
    if (params.includes('maxaveragebitrate')) return line;
    return `a=fmtp:${pt} ${params};usedtx=1;maxaveragebitrate=24000;stereo=0`;
  });
}

class VoiceChat {
  status: VoiceStatus = 'off';
  error = '';
  /** Ids of players heard talking right now (including 'me'). */
  speaking = new Set<string>();
  muted = new Set<string>();
  talking = false; // my mic is live right now
  private peers = new Map<string, Peer>();
  private room: unknown = null;
  private mic: MediaStream | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private wantOn = false;
  private pttDown = false;
  private pttHeld = new Set<string>(); // keys / pointers holding push-to-talk
  private proximity = new Map<string, number>();
  private listeners = new Set<() => void>();
  private version = 0;
  private timer = 0;
  private buf = new Float32Array(512);

  constructor() {
    if (typeof window === 'undefined') return;
    net.subscribe(() => this.sync());
    net.onPatch(() => this.syncSoon());
    net.onRtc((m) => void this.onSignal(m));
    settingsStore.subscribe(() => { this.applyMic(); this.applyGains(); });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', () => { this.pttHeld.clear(); this.setPtt(false); });
    if (location.search.includes('debug')) Object.assign(window, { __voice: this });
  }

  get supported() {
    return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }
  /** Voice needs an online room (there is nobody to talk to against bots). */
  get available() {
    return !!net.room && !net.offline && this.supported;
  }
  get joined() {
    return this.wantOn;
  }
  get mode() {
    return settingsStore.get().voiceMode;
  }
  peerState(id: string) {
    return this.peers.get(id)?.pc.connectionState ?? 'none';
  }
  connectedCount() {
    let n = 0;
    for (const p of this.peers.values()) if (p.pc.connectionState === 'connected') n++;
    return n;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  // ------------------------------------------------------------ join / leave
  async join() {
    if (!this.available || this.wantOn) return;
    this.wantOn = true;
    this.error = '';
    this.status = 'connecting';
    this.emit();
    audio.unlock();
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      const ctx = audio.ctx;
      if (ctx) {
        this.micAnalyser = ctx.createAnalyser();
        this.micAnalyser.fftSize = 512;
        ctx.createMediaStreamSource(this.mic).connect(this.micAnalyser);
      }
      this.status = 'on';
    } catch (e) {
      // No mic (or permission refused): still hear everyone.
      this.mic = null;
      this.status = 'listen-only';
      this.error = (e as Error)?.name === 'NotAllowedError'
        ? 'Microphone blocked. You can still hear others; allow the mic in your browser to talk.'
        : 'No microphone found. You can still hear others.';
    }
    if (!this.wantOn) { this.stopMic(); return; } // left while the permission prompt was open
    this.applyMic();
    net.send(MSG.VOICE, { on: true });
    this.sync();
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 100);
    this.emit();
  }

  leave() {
    if (!this.wantOn) return;
    this.wantOn = false;
    for (const id of [...this.peers.keys()]) this.closePeer(id, true);
    this.stopMic();
    net.send(MSG.VOICE, { on: false });
    this.status = 'off';
    this.speaking.clear();
    clearInterval(this.timer);
    this.timer = 0;
    this.emit();
  }

  toggleMute(id: string) {
    if (this.muted.has(id)) this.muted.delete(id);
    else this.muted.add(id);
    this.applyGains();
    this.emit();
  }

  setMode(mode: 'ptt' | 'open') {
    settingsStore.set({ voiceMode: mode });
    this.applyMic();
    this.emit();
  }

  /** Battleground proximity: 0..1 gain per player id (missing = full volume). */
  setProximity(gains: Map<string, number> | null) {
    this.proximity = gains ?? new Map();
    this.applyGains();
  }

  // ------------------------------------------------------------ push to talk
  pttStart(source = 'button') {
    this.pttHeld.add(source);
    this.setPtt(true);
  }
  /** Tap-to-talk (phones): first tap opens the mic, next tap closes it. */
  toggleTalk() {
    if (this.mode === 'open') { this.setMode('ptt'); this.pttHeld.clear(); this.setPtt(false); return; }
    if (this.pttHeld.has('tap')) this.pttEnd('tap');
    else this.pttStart('tap');
  }
  pttEnd(source = 'button') {
    this.pttHeld.delete(source);
    if (!this.pttHeld.size) this.setPtt(false);
  }
  private onKey = (e: KeyboardEvent) => {
    if (!this.wantOn) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!settingsStore.get().bindings.talk.includes(e.code)) return;
    if (e.type === 'keydown') { if (!e.repeat) this.pttStart('key:' + e.code); }
    else this.pttEnd('key:' + e.code);
  };
  private setPtt(down: boolean) {
    if (this.pttDown === down) return;
    this.pttDown = down;
    this.applyMic();
    this.emit();
  }
  private applyMic() {
    const live = !!this.mic && this.wantOn && (this.mode === 'open' || this.pttDown);
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = live; });
    if (live !== this.talking) {
      this.talking = live;
      this.emit();
    }
  }
  private stopMic() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micAnalyser = null;
    this.talking = false;
  }

  // ------------------------------------------------------------ peers
  private syncQueued = false;
  private syncSoon() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    setTimeout(() => { this.syncQueued = false; this.sync(); }, 250);
  }

  /** Match peer connections to the players currently in voice. */
  private sync() {
    if (net.room !== this.room) {
      // New room or a reconnect: start every connection over.
      for (const id of [...this.peers.keys()]) this.closePeer(id, false);
      this.room = net.room;
      if (!net.room || net.offline) {
        if (this.wantOn) this.leave();
        this.emit();
        return;
      }
      if (this.wantOn) net.send(MSG.VOICE, { on: true });
    }
    if (!this.wantOn || !net.room) return;
    const st = net.room.state;
    const me = net.myId;
    const wanted = new Set<string>();
    st?.players?.forEach((p: { id: string; voice: boolean; connected: boolean }, id: string) => {
      if (id !== me && p.voice && p.connected) wanted.add(id);
    });
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.closePeer(id, false);
    for (const id of wanted) if (!this.peers.has(id)) this.createPeer(id);
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // The player with the smaller id makes the offer, so both sides never offer at once.
    const peer: Peer = { id, pc, initiator: net.myId < id, pendingIce: [], el: null, src: null, gain: null, analyser: null, retryT: 0 };
    this.peers.set(id, peer);
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.mic) pc.addTrack(track, this.mic);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = (e) => { if (e.candidate) net.send(MSG.RTC, { to: id, kind: 'ice', data: e.candidate.toJSON() }); };
    pc.ontrack = (e) => this.attachAudio(peer, e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.limitBitrate(pc);
      if ((s === 'failed' || s === 'disconnected') && peer.initiator && this.peers.get(id) === peer) {
        // Try again a little later (ICE restart is overkill for a game).
        peer.retryT = window.setTimeout(() => {
          if (this.peers.get(id) !== peer || pc.connectionState === 'connected') return;
          this.closePeer(id, true);
          this.sync();
        }, s === 'failed' ? 1500 : 6000);
      }
      this.emit();
    };
    if (peer.initiator) void this.makeOffer(peer);
    this.emit();
    return peer;
  }

  private async makeOffer(peer: Peer) {
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ type: 'offer', sdp: tuneSdp(offer.sdp ?? '') });
      net.send(MSG.RTC, { to: peer.id, kind: 'offer', data: peer.pc.localDescription?.toJSON() });
    } catch (e) {
      console.warn('voice offer failed', e);
    }
  }

  private async onSignal(m: RtcSignal) {
    const from = m.from;
    if (!from || !this.wantOn) return;
    let peer = this.peers.get(from);
    try {
      if (m.kind === 'bye') { if (peer) this.closePeer(from, false); return; }
      if (m.kind === 'offer') {
        // A fresh offer replaces any half-made connection.
        if (peer && peer.pc.signalingState !== 'stable') { this.closePeer(from, false); peer = undefined; }
        if (!peer) peer = this.createPeer(from);
        await peer.pc.setRemoteDescription(m.data as RTCSessionDescriptionInit);
        await this.flushIce(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription({ type: 'answer', sdp: tuneSdp(answer.sdp ?? '') });
        net.send(MSG.RTC, { to: from, kind: 'answer', data: peer.pc.localDescription?.toJSON() });
      } else if (m.kind === 'answer') {
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(m.data as RTCSessionDescriptionInit);
        await this.flushIce(peer);
      } else if (m.kind === 'ice') {
        if (!peer) return;
        if (!peer.pc.remoteDescription) peer.pendingIce.push(m.data as RTCIceCandidateInit);
        else await peer.pc.addIceCandidate(m.data as RTCIceCandidateInit);
      }
    } catch (e) {
      console.warn('voice signalling error', e);
    }
  }

  private async flushIce(peer: Peer) {
    const list = peer.pendingIce.splice(0);
    for (const c of list) {
      try { await peer.pc.addIceCandidate(c); } catch { /* stale candidate */ }
    }
  }

  private limitBitrate(pc: RTCPeerConnection) {
    for (const s of pc.getSenders()) {
      if (s.track?.kind !== 'audio') continue;
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 24000;
      s.setParameters(p).catch(() => {});
    }
  }

  private attachAudio(peer: Peer, stream: MediaStream) {
    // Chrome only feeds a remote stream into Web Audio while a media element plays it;
    // the element itself stays muted and the sound goes through our gain node.
    if (!peer.el) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      peer.el = el;
    }
    peer.el.srcObject = stream;
    const ctx = audio.ctx;
    if (ctx) {
      peer.el.muted = true;
      void peer.el.play().catch(() => {});
      peer.src?.disconnect();
      peer.src = ctx.createMediaStreamSource(stream);
      peer.analyser = ctx.createAnalyser();
      peer.analyser.fftSize = 512;
      peer.gain = ctx.createGain();
      peer.src.connect(peer.analyser);
      peer.src.connect(peer.gain).connect(ctx.destination);
    } else {
      // No Web Audio context (shouldn't happen after a tap): play the element directly.
      peer.el.muted = false;
      void peer.el.play().catch(() => {});
    }
    this.applyGains();
  }

  private applyGains() {
    const vol = settingsStore.get().voiceVolume;
    const ctx = audio.ctx;
    for (const p of this.peers.values()) {
      const g = this.muted.has(p.id) ? 0 : vol * (this.proximity.get(p.id) ?? 1);
      if (p.gain && ctx) p.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.08);
      else if (p.el && !p.gain) p.el.volume = Math.min(1, g);
    }
  }

  private closePeer(id: string, sayBye: boolean) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    clearTimeout(p.retryT);
    try { p.pc.close(); } catch { /* closed */ }
    p.src?.disconnect();
    p.gain?.disconnect();
    if (p.el) { p.el.srcObject = null; p.el.remove(); }
    this.speaking.delete(id);
    if (sayBye) net.send(MSG.RTC, { to: id, kind: 'bye' });
    this.emit();
  }

  // ------------------------------------------------------------ talking indicators
  private level(a: AnalyserNode | null) {
    if (!a) return 0;
    a.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.sqrt(sum / this.buf.length);
  }
  private tick() {
    const now = new Set<string>();
    if (this.talking && this.level(this.micAnalyser) > 0.015) now.add(net.myId);
    for (const p of this.peers.values()) {
      if (!this.muted.has(p.id) && this.level(p.analyser) > 0.012) now.add(p.id);
    }
    const changed = now.size !== this.speaking.size || [...now].some((id) => !this.speaking.has(id));
    if (changed) {
      this.speaking = now;
      this.emit();
    }
  }
}

export const voice = new VoiceChat();
