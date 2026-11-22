import { useLayoutEffect, useRef } from 'react';
import { PhoneMarkup } from './generated/PhoneMarkup';
import { StageMarkup } from './generated/StageMarkup';
import './liquid.css';
import { StageTimeline } from './StageTimeline';

type Surface = 'phone' | 'stage';

function useSurface(surface: Surface) {
  const attached = useRef(false);
  useLayoutEffect(() => {
    if (attached.current) return;
    attached.current = true;
    const body = document.body;
    body.classList.add('wasp-liquid');
    body.dataset.surface = surface;
    if (surface === 'stage') {
      body.dataset.stageRoot = '';
      body.dataset.phase = 'lobby';
      body.dataset.link = 'connecting';
      document.title = 'Telepath · Stage';
    }
    for (const path of ['/' + surface + '.css', '/channel-monitor.css']) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = path;
      document.head.append(link);
    }
    const controller = document.createElement('script');
    controller.type = 'module';
    controller.src = '/' + surface + '.mjs';
    document.body.append(controller);
  }, [surface]);
}

export function PhoneSurface() {
  useSurface('phone');
  return <PhoneMarkup />;
}

export function StageSurface() {
  useSurface('stage');
  return <><StageTimeline /><StageMarkup /></>;
}
