// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { DEFAULT_VPS } from '../../agent/yeaft/vp/seed-defaults.js';
import { buildVpDomainSections } from '../../web/utils/vp-domains.js';

let browser;
let css;

function rosterMarkup() {
  return buildVpDomainSections(DEFAULT_VPS).map(domain => `
    <section class="yeaft-roster-domain-section">
      <h3 class="vp-domain-heading yeaft-roster-domain">${domain.id}</h3>
      <ul class="yeaft-roster-domain-list">
        ${domain.vps.map(vp => `
          <li class="yeaft-roster-item">
            <label class="yeaft-roster-row">
              <input type="checkbox">
              <span class="yeaft-roster-copy">
                <span class="yeaft-roster-name">${vp.displayName || vp.vpId}</span>
                <span class="yeaft-roster-description">${vp.role || 'VP capability'}</span>
              </span>
            </label>
          </li>
        `).join('')}
      </ul>
    </section>
  `).join('');
}

async function renderPopup(viewport, agentCount) {
  const page = await browser.newPage({ viewport });
  await page.setContent(`
    <style>${css}</style>
    <div class="modal-overlay">
      <div class="modal resume-modal yeaft-session-create-modal">
        <div class="resume-modal-controls">
          ${agentCount > 1 ? `
            <div class="resume-control-row">
              <label class="resume-control-label">Agent</label>
              <select class="resume-input"><option>One</option></select>
            </div>
          ` : ''}
          <div class="resume-control-row">
            <label class="resume-control-label">Name</label>
            <input class="resume-input">
          </div>
          <div class="resume-control-row">
            <label class="resume-control-label">Work</label>
            <input class="resume-input">
          </div>
          <div class="resume-control-row resume-control-row-vp">
            <label class="resume-control-label">VP</label>
            <div class="yeaft-roster">
              <button class="yeaft-roster-trigger">Omni</button>
              <div class="yeaft-roster-list yeaft-roster-popup">${rosterMarkup()}</div>
            </div>
          </div>
        </div>
        <div class="resume-modal-content"></div>
      </div>
    </div>
  `);

  try {
    return await page.evaluate(async () => {
      const modal = document.querySelector('.resume-modal');
      const trigger = document.querySelector('.yeaft-roster-trigger');
      const popup = document.querySelector('.yeaft-roster-popup');
      const anchorRect = trigger.getBoundingClientRect();
      const boundaryRect = modal.getBoundingClientRect();
      const viewportRect = { top: 0, bottom: innerHeight };
      const boundaryTop = Math.max(boundaryRect.top, viewportRect.top);
      const boundaryBottom = Math.min(boundaryRect.bottom, viewportRect.bottom);
      const above = Math.max(0, anchorRect.top - boundaryTop - 4);
      const below = Math.max(0, boundaryBottom - anchorRect.bottom - 4);
      const previousMaxHeight = popup.style.maxHeight;
      popup.style.maxHeight = 'none';
      const desiredHeight = popup.scrollHeight;
      popup.style.maxHeight = previousMaxHeight;
      const placement = below < desiredHeight && above > below ? 'up' : 'down';
      const availableHeight = Math.floor(placement === 'up' ? above : below);

      popup.classList.toggle('opens-up', placement === 'up');
      popup.style.setProperty('--vp-roster-available-height', `${availableHeight}px`);
      await new Promise(requestAnimationFrame);

      const popupRect = popup.getBoundingClientRect();
      const clipTop = Math.max(boundaryRect.top, viewportRect.top);
      const clipBottom = Math.min(boundaryRect.bottom, viewportRect.bottom);
      popup.scrollTop = popup.scrollHeight;
      const options = popup.querySelectorAll('.yeaft-roster-item');
      const lastOptionRect = options[options.length - 1].getBoundingClientRect();
      return {
        placement,
        popupTop: popupRect.top,
        popupBottom: popupRect.bottom,
        clipTop,
        clipBottom,
        lastOptionTop: lastOptionRect.top,
        lastOptionBottom: lastOptionRect.bottom,
        scrollTop: popup.scrollTop,
      };
    });
  } finally {
    await page.close();
  }
}

beforeAll(async () => {
  css = (await Promise.all([
    'variables.css',
    'chat-modals.css',
    'yeaft-vp.css',
    'yeaft-session-create.css',
  ].map(file => readFile(new URL(`../../web/styles/${file}`, import.meta.url), 'utf8')))).join('\n');
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe('SessionCreate VP popup browser layout', () => {
  for (const agentCount of [1, 2]) {
    for (const viewport of [
      { width: 844, height: 390 },
      { width: 768, height: 480 },
      { width: 640, height: 390 },
    ]) {
      it(`keeps the last option reachable with ${agentCount} agent row(s) at ${viewport.width}x${viewport.height}`, async () => {
        const layout = await renderPopup(viewport, agentCount);

        expect(layout.popupTop).toBeGreaterThanOrEqual(layout.clipTop - 1);
        expect(layout.popupBottom).toBeLessThanOrEqual(layout.clipBottom + 1);
        expect(layout.lastOptionTop).toBeGreaterThanOrEqual(layout.popupTop - 1);
        expect(layout.lastOptionBottom).toBeLessThanOrEqual(layout.popupBottom + 1);
        expect(layout.scrollTop).toBeGreaterThan(0);
      });
    }
  }
});
