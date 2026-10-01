/** @vitest-environment jsdom */

// ContactTemplateEditor (EPIC-023 SPEC.md §2 US-2, §3.2, §5; T-0446): renders
// the template `properties` and `variables` maps and round-trips both unchanged
// when saved.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContactTemplateEditor,
  parseObjectField,
  type ContactTemplate,
} from "./ContactTemplateEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEMPLATE: ContactTemplate = {
  id: "tpl-1",
  name: "Vendor",
  properties: { displayName: "Vendor", externalAddress: "vendor@example.invalid" },
  variables: { region: "eu", tier: "gold" },
};

describe("parseObjectField", () => {
  it("accepts a JSON object and rejects scalars, arrays, and invalid JSON", () => {
    expect(parseObjectField('{"a":1}', "Properties")).toEqual({ ok: true, value: { a: 1 } });
    expect(parseObjectField("[]", "Properties").ok).toBe(false);
    expect(parseObjectField("null", "Properties").ok).toBe(false);
    expect(parseObjectField("3", "Properties").ok).toBe(false);
    expect(parseObjectField("{", "Properties").ok).toBe(false);
  });
});

describe("ContactTemplateEditor", () => {
  it("renders the template name, properties, and variables", () => {
    render(
      <ContactTemplateEditor initialTemplate={TEMPLATE} onSave={() => undefined} onCancel={() => undefined} />,
    );

    expect((screen.getByTestId("contact-template-name") as HTMLInputElement).value).toBe("Vendor");
    const properties = (screen.getByTestId("contact-template-properties") as HTMLTextAreaElement).value;
    expect(properties).toContain('"displayName": "Vendor"');
    expect(properties).toContain('"externalAddress": "vendor@example.invalid"');
    const variables = (screen.getByTestId("contact-template-variables") as HTMLTextAreaElement).value;
    expect(variables).toContain('"region": "eu"');
    expect(variables).toContain('"tier": "gold"');
  });

  it("round-trips properties and variables unchanged when saved untouched", async () => {
    const onSave = vi.fn();
    render(
      <ContactTemplateEditor initialTemplate={TEMPLATE} onSave={onSave} onCancel={() => undefined} />,
    );

    fireEvent.click(screen.getByTestId("contact-template-editor-save"));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      name: "Vendor",
      properties: TEMPLATE.properties,
      variables: TEMPLATE.variables,
    });
  });

  it("saves edited name and maps", () => {
    const onSave = vi.fn();
    render(
      <ContactTemplateEditor initialTemplate={TEMPLATE} onSave={onSave} onCancel={() => undefined} />,
    );

    fireEvent.change(screen.getByTestId("contact-template-name"), { target: { value: "Vendor v2" } });
    fireEvent.change(screen.getByTestId("contact-template-properties"), {
      target: { value: '{"displayName":"Renamed"}' },
    });
    fireEvent.change(screen.getByTestId("contact-template-variables"), {
      target: { value: '{"region":"us"}' },
    });
    fireEvent.click(screen.getByTestId("contact-template-editor-save"));

    expect(onSave).toHaveBeenCalledWith({
      name: "Vendor v2",
      properties: { displayName: "Renamed" },
      variables: { region: "us" },
    });
  });

  it("rejects invalid JSON and never saves", () => {
    const onSave = vi.fn();
    render(
      <ContactTemplateEditor initialTemplate={TEMPLATE} onSave={onSave} onCancel={() => undefined} />,
    );

    fireEvent.change(screen.getByTestId("contact-template-properties"), { target: { value: "{" } });
    fireEvent.click(screen.getByTestId("contact-template-editor-save"));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("contact-template-editor-error").textContent).toContain("Properties");
  });

  it("rejects a non-object variables map and never saves", () => {
    const onSave = vi.fn();
    render(
      <ContactTemplateEditor initialTemplate={TEMPLATE} onSave={onSave} onCancel={() => undefined} />,
    );

    fireEvent.change(screen.getByTestId("contact-template-variables"), { target: { value: "[]" } });
    fireEvent.click(screen.getByTestId("contact-template-editor-save"));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("contact-template-editor-error").textContent).toContain("Variables");
  });

  it("defaults a new template to empty maps and requires a name", () => {
    const onSave = vi.fn();
    render(<ContactTemplateEditor onSave={onSave} onCancel={() => undefined} />);

    expect((screen.getByTestId("contact-template-properties") as HTMLTextAreaElement).value).toBe("{}");
    expect((screen.getByTestId("contact-template-variables") as HTMLTextAreaElement).value).toBe("{}");

    fireEvent.click(screen.getByTestId("contact-template-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("contact-template-editor-error").textContent).toContain("name");
  });

  it("cancels without saving", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<ContactTemplateEditor initialTemplate={TEMPLATE} onSave={onSave} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId("contact-template-editor-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
