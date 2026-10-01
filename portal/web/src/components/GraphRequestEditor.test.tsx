// T-0782 — Graph Explorer request editor (EPIC-040 SPEC.md §3.1, §8).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  GraphRequestEditor,
  GRAPH_EXPLORER_METHODS,
  isWriteMethod,
  validateJsonBody,
  type GraphExplorerMethod,
} from "./GraphRequestEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function EditorHarness(): React.ReactElement {
  // eslint-disable-next-line react/react-in-jsx-scope
  const [method, setMethod] = React.useState<GraphExplorerMethod>("GET");
  const [url, setUrl] = React.useState("https://graph.microsoft.com/v1.0/");
  const [body, setBody] = React.useState("");
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  return (
    <GraphRequestEditor
      method={method}
      url={url}
      body={body}
      onMethodChange={setMethod}
      onUrlChange={setUrl}
      onBodyChange={setBody}
      onJsonErrorChange={setJsonError}
    />
  );
}

describe("validateJsonBody", () => {
  it("accepts an empty body", () => {
    expect(validateJsonBody("")).toBeNull();
    expect(validateJsonBody("   ")).toBeNull();
  });

  it("accepts valid JSON", () => {
    expect(validateJsonBody('{"displayName":"Example"}')).toBeNull();
    expect(validateJsonBody("[1,2,3]")).toBeNull();
  });

  it("rejects malformed JSON with the parse message", () => {
    const error = validateJsonBody("{displayName}");
    expect(error).not.toBeNull();
    expect(error).toContain("JSON");
  });
});

describe("isWriteMethod", () => {
  it("marks only POST/PATCH/PUT/DELETE as elevated", () => {
    expect(isWriteMethod("GET")).toBe(false);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      expect(isWriteMethod(method)).toBe(true);
    }
  });
});

describe("GraphRequestEditor", () => {
  it("renders the method select, URL input, and body editor with every allowlisted method", () => {
    render(<EditorHarness />);

    expect(screen.getByTestId("graph-request-editor")).toBeTruthy();
    const select = screen.getByTestId("graph-method-select");
    expect(select).toBeTruthy();
    for (const method of GRAPH_EXPLORER_METHODS) {
      expect(screen.getByRole("option", { name: method })).toBeTruthy();
    }
    expect(screen.getByTestId("graph-url-input")).toBeTruthy();
    expect(screen.getByTestId("graph-body-input")).toBeTruthy();
  });

  it("does not mark GET as elevated and carries no audited warning", () => {
    render(<EditorHarness />);

    expect(screen.queryByTestId("graph-elevated-badge")).toBeNull();
    expect(screen.queryByTestId("graph-audited-warning")).toBeNull();
  });

  it("marks a write method elevated and carries an audited warning before Run", () => {
    render(<EditorHarness />);

    fireEvent.change(screen.getByTestId("graph-method-select"), { target: { value: "DELETE" } });

    expect(screen.getByTestId("graph-elevated-badge").textContent).toContain("Elevated");
    const warning = screen.getByTestId("graph-audited-warning");
    expect(warning.textContent).toContain("audited");
    expect(warning.textContent).toContain("elevated");
  });

  it("reports malformed JSON inline through onJsonErrorChange", () => {
    const onJsonErrorChange = vi.fn();
    render(
      <GraphRequestEditor
        method="POST"
        url="https://graph.microsoft.com/v1.0/users"
        body="{displayName}"
        onMethodChange={vi.fn()}
        onUrlChange={vi.fn()}
        onBodyChange={vi.fn()}
        onJsonErrorChange={onJsonErrorChange}
      />,
    );

    expect(screen.getByTestId("graph-json-error").textContent).toContain("JSON");
    expect(onJsonErrorChange).toHaveBeenCalledWith(expect.stringContaining("JSON"));
  });

  it("reports a null error for a valid body", () => {
    const onJsonErrorChange = vi.fn();
    render(
      <GraphRequestEditor
        method="POST"
        url="https://graph.microsoft.com/v1.0/users"
        body='{"displayName":"Example"}'
        onMethodChange={vi.fn()}
        onUrlChange={vi.fn()}
        onBodyChange={vi.fn()}
        onJsonErrorChange={onJsonErrorChange}
      />,
    );

    expect(screen.queryByTestId("graph-json-error")).toBeNull();
    expect(onJsonErrorChange).toHaveBeenCalledWith(null);
  });

  it("emits method, URL, and body changes to the parent", () => {
    render(<EditorHarness />);

    fireEvent.change(screen.getByTestId("graph-method-select"), { target: { value: "PATCH" } });
    fireEvent.change(screen.getByTestId("graph-url-input"), {
      target: { value: "https://graph.microsoft.com/v1.0/users/1" },
    });
    fireEvent.change(screen.getByTestId("graph-body-input"), {
      target: { value: '{"displayName":"Renamed"}' },
    });

    expect((screen.getByTestId("graph-method-select") as HTMLSelectElement).value).toBe("PATCH");
    expect((screen.getByTestId("graph-url-input") as HTMLInputElement).value).toBe(
      "https://graph.microsoft.com/v1.0/users/1",
    );
    expect((screen.getByTestId("graph-body-input") as HTMLTextAreaElement).value).toBe(
      '{"displayName":"Renamed"}',
    );
  });
});
