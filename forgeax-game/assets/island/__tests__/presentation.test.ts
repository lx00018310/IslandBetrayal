import { expect, it } from 'vitest';
import { islandCameraBounds } from '../presentation.ts';

it.each([[1280, 720], [1280, 600], [844, 390], [390, 844]])('视口 %sx%s 保持体素比例与最低横向视野', (width, height) => {
  const view = islandCameraBounds(width, height);
  expect((view.right - view.left) / (view.top - view.bottom)).toBeCloseTo(width / height);
  expect(view.right - view.left).toBeGreaterThanOrEqual(8);
});
