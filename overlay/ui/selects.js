'use strict';

// Keep the native selects as the settings model, but render their pickers in
// this window. Chromium's native picker requires an activatable Win32 window.
// In-page buttons work in the passive overlay without taking browser focus.
(() => {
  const controls = new Map();
  let opened = null, refreshQueued = false, sequence = 0, typed = '', typedTimer;
  const optionRows = select => [...select.options].map(option => ({ value: option.value, text: option.label || option.textContent, disabled: option.disabled || option.parentElement?.disabled === true }));
  function labelFor(select) {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    const label = select.labels?.[0];
    const text = label ? [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ').trim() : '';
    return text || select.id || 'Choose an option';
  }
  function close() {
    if (!opened) return;
    const current = opened; opened = null;
    current.button.setAttribute('aria-expanded', 'false');
    current.button.removeAttribute('aria-activedescendant');
    try { current.menu.hidePopover(); } catch { /* Already removed/closed. */ }
    current.menu.remove();
    clearTimeout(typedTimer); typed = '';
  }
  function place(current) {
    const rect = current.button.getBoundingClientRect();
    const menu = current.menu;
    const width = Math.min(Math.max(rect.width, 180), innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(60, Math.min(300, innerHeight - 24))}px`;
    const height = Math.min(menu.scrollHeight, Math.min(300, innerHeight - 24));
    const below = innerHeight - rect.bottom - 8;
    const top = below >= Math.min(height, 140) || rect.top < below ? rect.bottom + 4 : rect.top - height - 4;
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
    const available = top >= rect.bottom ? innerHeight - top - 8 : rect.top - 12;
    menu.style.maxHeight = `${Math.max(60, Math.min(300, available))}px`;
  }
  function highlight(current, index, scroll = false) {
    current.index = index;
    [...current.menu.children].forEach((row, position) => row.classList.toggle('active', position === index));
    const row = current.menu.children[index];
    if (row) {
      current.button.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }
  }
  function choose(current, index) {
    const row = current.rows[index];
    if (!row || row.disabled || current.select.disabled) return;
    const changed = current.select.value !== row.value;
    current.select.value = row.value;
    close(); refresh();
    if (changed) {
      current.select.dispatchEvent(new Event('input', { bubbles: true }));
      current.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function renderMenu(current) {
    const oldValue = current.rows?.[current.index]?.value;
    current.rows = optionRows(current.select);
    current.menu.replaceChildren(...current.rows.map((option, index) => {
      const row = document.createElement('button');
      row.type = 'button'; row.tabIndex = -1; row.className = 'overlay-select-option';
      row.id = `${current.button.id}-option-${index}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.value === current.select.value));
      row.textContent = option.text; row.disabled = option.disabled;
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('pointermove', () => { if (!option.disabled) highlight(current, index); });
      row.addEventListener('click', event => { event.preventDefault(); choose(current, index); });
      return row;
    }));
    let index = current.rows.findIndex(row => row.value === oldValue && !row.disabled);
    if (index < 0) index = current.rows.findIndex(row => row.value === current.select.value && !row.disabled);
    if (index < 0) index = current.rows.findIndex(row => !row.disabled);
    highlight(current, index);
    place(current);
  }
  function open(current) {
    if (current.button.disabled || current.button.hidden) return;
    if (opened === current) { close(); return; }
    close();
    const menu = document.createElement('div');
    menu.className = 'overlay-select-list'; menu.id = `${current.button.id}-list`;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', labelFor(current.select));
    menu.setAttribute('popover', 'manual');
    (current.select.closest('dialog[open]') || document.body).append(menu);
    current.menu = menu; current.rows = []; current.index = -1; opened = current;
    current.button.setAttribute('aria-controls', menu.id); current.button.setAttribute('aria-expanded', 'true');
    menu.showPopover(); renderMenu(current);
    current.signature = signature(current.select);
  }
  const signature = select => JSON.stringify([select.value, select.disabled, select.hidden, optionRows(select)]);
  function enhance(select) {
    if (controls.has(select)) return controls.get(select);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'overlay-select-trigger';
    button.id = `${select.id || `select-${++sequence}`}-picker`;
    button.dataset.selectId = select.id;
    button.setAttribute('role', 'combobox'); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    select.classList.add('overlay-select-native'); select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.before(button);
    const current = { select, button, signature: '' };
    controls.set(select, current);
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', event => { event.preventDefault(); open(current); });
    select.addEventListener('change', refresh);
    button.addEventListener('keydown', event => {
      if (button.disabled) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (opened !== current) { open(current); return; }
        if (event.key === 'Enter' || event.key === ' ') { choose(current, current.index); return; }
        const enabled = current.rows.map((row, i) => row.disabled ? -1 : i).filter(i => i >= 0);
        let position = enabled.indexOf(current.index);
        if (event.key === 'Home') position = 0;
        else if (event.key === 'End') position = enabled.length - 1;
        else position = (position + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        highlight(current, enabled[position], true);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        if (opened !== current) open(current);
        typed += event.key.toLowerCase(); clearTimeout(typedTimer); typedTimer = setTimeout(() => { typed = ''; }, 700);
        const index = current.rows.findIndex(row => !row.disabled && row.text.toLowerCase().startsWith(typed));
        if (index >= 0) highlight(current, index, true);
      }
    });
    return current;
  }
  function refresh() {
    for (const select of document.querySelectorAll('select')) {
      const current = enhance(select), next = signature(select);
      const selected = select.selectedOptions[0];
      current.button.textContent = selected?.label || selected?.textContent || 'Choose an option';
      current.button.setAttribute('aria-label', `${labelFor(select)}: ${current.button.textContent}`);
      current.button.title = select.title || current.button.textContent;
      current.button.disabled = select.disabled || !!select.closest('fieldset[disabled]');
      if (current.button.hidden !== select.hidden) current.button.hidden = select.hidden;
      if (opened === current) {
        if (current.button.disabled || !current.button.getClientRects().length || (current.button.closest('dialog') && !current.button.closest('dialog').open)) close();
        else if (next !== current.signature) renderMenu(current);
      }
      current.signature = next;
    }
    for (const [select, current] of controls) if (!select.isConnected) { if (opened === current) close(); current.button.remove(); controls.delete(select); }
  }
  document.addEventListener('pointerdown', event => {
    if (opened && !opened.button.contains(event.target) && !opened.menu.contains(event.target)) close();
  }, true);
  document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    else if (event.key === 'Tab') close();
  }, true);
  document.addEventListener('scroll', () => { if (opened) place(opened); }, true);
  addEventListener('resize', () => { if (opened) place(opened); });
  addEventListener('blur', close);
  new MutationObserver(records => {
    if (!records.some(record => record.target instanceof HTMLSelectElement || record.target.closest?.('select') || [...record.addedNodes].some(node => node instanceof HTMLSelectElement))) return;
    if (!refreshQueued) { refreshQueued = true; queueMicrotask(() => { refreshQueued = false; refresh(); }); }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label', 'value', 'style'] });
  window.overlaySelects = Object.freeze({ refresh, close });
  refresh();
})();
