import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

if (typeof Element !== "undefined") Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { if (typeof document !== "undefined") cleanup(); if (typeof localStorage !== "undefined") localStorage.clear(); });
