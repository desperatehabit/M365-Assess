/** @vitest-environment jsdom */
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { KeyReveal } from "./KeyReveal";

afterEach(cleanup);

describe("KeyReveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a Reveal button initially", () => {
    render(<KeyReveal keyValue="test-key-123" />);
    expect(screen.getByText("Reveal")).toBeTruthy();
  });

  it("does not show the key value before reveal", () => {
    render(<KeyReveal keyValue="test-key-123" />);
    expect(screen.queryByText("test-key-123")).toBeNull();
  });

  it("shows the key value after Reveal is clicked", () => {
    render(<KeyReveal keyValue="test-key-123" />);

    fireEvent.click(screen.getByText("Reveal"));
    expect(screen.getByText("test-key-123")).toBeTruthy();
  });

  it("shows a countdown after reveal", () => {
    render(<KeyReveal keyValue="test-key-123" revealWindowSec={30} />);

    fireEvent.click(screen.getByText("Reveal"));
    expect(screen.getByText("30s")).toBeTruthy();
  });

  it("auto-hides after the configured window", () => {
    render(<KeyReveal keyValue="test-key-123" revealWindowSec={5} />);

    fireEvent.click(screen.getByText("Reveal"));
    expect(screen.getByText("test-key-123")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("test-key-123")).toBeNull();
    expect(screen.getByText("Reveal")).toBeTruthy();
  });

  it("counts down every second", () => {
    render(<KeyReveal keyValue="test-key-123" revealWindowSec={10} />);

    fireEvent.click(screen.getByText("Reveal"));
    expect(screen.getByText("10s")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText("7s")).toBeTruthy();
  });

  it("hides immediately when Hide is clicked", () => {
    render(<KeyReveal keyValue="test-key-123" />);

    fireEvent.click(screen.getByText("Reveal"));
    expect(screen.getByText("test-key-123")).toBeTruthy();

    fireEvent.click(screen.getByText("Hide"));
    expect(screen.queryByText("test-key-123")).toBeNull();
    expect(screen.getByText("Reveal")).toBeTruthy();
  });

  it("shows a Copy button when revealed", () => {
    render(<KeyReveal keyValue="test-key-123" />);

    fireEvent.click(screen.getByText("Reveal"));
    expect(screen.getByText("Copy")).toBeTruthy();
  });
});
