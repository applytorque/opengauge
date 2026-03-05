/**
 * Vendor — re-exports Preact + HTM from CDN (ESM, no build step)
 *
 * The imports below are resolved at runtime by the browser.
 * esm.sh serves minified ES modules with proper dependency resolution.
 */

import { h, render as preactRender } from 'https://esm.sh/preact@10.24.3';
import { useState, useEffect, useRef, useCallback, useMemo } from 'https://esm.sh/preact@10.24.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(h);

function render(vnode, container) {
  preactRender(vnode, container);
}

export {
  html,
  render,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
};
