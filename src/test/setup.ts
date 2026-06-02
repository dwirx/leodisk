import "@testing-library/jest-dom/vitest";
import { createElement, type ReactNode } from "react";
import { vi } from "vitest";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      createElement("div", { className: "recharts-responsive-mock" }, children),
  };
});

Object.defineProperties(HTMLElement.prototype, {
  clientWidth: { configurable: true, value: 640 },
  clientHeight: { configurable: true, value: 240 },
  offsetWidth: { configurable: true, value: 640 },
  offsetHeight: { configurable: true, value: 240 },
});

const testRect = {
  x: 0,
  y: 0,
  width: 640,
  height: 240,
  top: 0,
  right: 640,
  bottom: 240,
  left: 0,
  toJSON: () => ({}),
};

Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return testRect;
};

HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return testRect;
};

SVGElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return testRect;
};

(SVGElement.prototype as unknown as { getBBox: () => { x: number; y: number; width: number; height: number } }).getBBox = function getBBox() {
  return {
    x: 0,
    y: 0,
    width: 640,
    height: 240,
  };
};

class TestResizeObserver {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: testRect,
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
