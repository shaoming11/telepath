import { app, page, route } from '@wasp.sh/spec';
import { PhoneSurface, StageSurface } from './src/Surfaces' with { type: 'ref' };

export default app({
  name: 'telepath',
  wasp: { version: '^0.26.0' },
  title: 'Telepath',
  head: ['<meta name="color-scheme" content="dark" />'],
  spec: [
    route('PhoneRoute', '/', page(PhoneSurface)),
    route('StageRoute', '/stage', page(StageSurface)),
  ],
});
