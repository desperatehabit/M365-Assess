import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DefenderSetupPage from "./page";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Defender Setup page (T-0849)", () => {
  it("prompts for a tenant before mounting the wizard", () => {
    render(<DefenderSetupPage />);
    expect(screen.getByTestId("defender-setup-page")).toBeTruthy();
    expect(screen.getByTestId("defender-setup-empty")).toBeTruthy();
    expect(screen.queryByTestId("wizard-step-areas")).toBeNull();
  });

  it("mounts the setup wizard once a tenant is entered", () => {
    render(<DefenderSetupPage />);
    fireEvent.change(screen.getByTestId("defender-setup-tenant-input"), {
      target: { value: "tenant-a" },
    });
    expect(screen.getByTestId("wizard-step-areas")).toBeTruthy();
  });
});
