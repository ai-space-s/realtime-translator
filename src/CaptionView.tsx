import { useEffect, useRef, useState } from 'react';
import { channelName, defaultCaption, type CaptionState } from './captionChannel';
import { Icon } from './Icon';
import { CaptionDisplayMode, CaptionFlow } from './CaptionFlow';

export function CaptionView() {
  const [caption, setCaption] = useState<CaptionState>(defaultCaption);
  const [connected, setConnected] = useState(false);
  const [controllerLost, setControllerLost] = useState(false);
  const lastSeen = useRef(Date.now());
  const broadcast = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('channel');
    if (!id || !('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel(channelName(id));
    broadcast.current = channel;
    channel.onmessage = ({ data }) => {
      if (data.type === 'caption') { setCaption(data.state); setConnected(true); setControllerLost(false); lastSeen.current = Date.now(); }
      if (data.type === 'closed') setControllerLost(true);
    };
    channel.postMessage({ type: 'ready' });
    const heartbeat = setInterval(() => {
      channel.postMessage({ type: 'ready' });
      if (Date.now() - lastSeen.current > 7000) setControllerLost(true);
    }, 2000);
    return () => { clearInterval(heartbeat); channel.close(); broadcast.current = null; };
  }, []);
  function setDisplayMode(showSource: boolean) {
    setCaption(current => ({ ...current, showSource }));
    broadcast.current?.postMessage({ type: 'display-mode', showSource });
  }
  async function fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen().catch(() => {});
  }
  return <main className="audience">
    <div className="audience-tools"><span>Between <i>/</i> Caption</span><div className="audience-actions"><CaptionDisplayMode showSource={caption.showSource} onChange={setDisplayMode}/><button onClick={fullscreen}><Icon name="expand" size={16}/> 전체화면</button></div></div>
    {!caption.hidden && <div className="audience-content">
      <div className="audience-label"><span className={caption.live && !controllerLost ? 'dot live' : 'dot'}/>{caption.demo ? '데모 자막' : caption.title} <span>· {caption.language}</span></div>
      <CaptionFlow caption={caption} waiting={!connected}/>
      {controllerLost && <p className="audience-notice">운영자 연결이 끊어졌습니다 · 마지막 자막</p>}
    </div>}
    <span className="audience-brand">BETWEEN</span>
  </main>;
}
