"use client";

// DeviceFilters — filter controls for the Devices list (EPIC-018 SPEC.md §3.1; T-0348).
// Filters: platform, compliance, ownership, last check-in age, encrypted, search.
import React, { type CSSProperties } from "react";

export interface DeviceFiltersProps {
  readonly platform: string;
  readonly compliance: string;
  readonly ownership: string;
  readonly lastCheckIn: string;
  readonly encrypted: string;
  readonly search: string;
  readonly onPlatformChange: (value: string) => void;
  readonly onComplianceChange: (value: string) => void;
  readonly onOwnershipChange: (value: string) => void;
  readonly onLastCheckInChange: (value: string) => void;
  readonly onEncryptedChange: (value: string) => void;
  readonly onSearchChange: (value: string) => void;
}

const containerStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  alignItems: "center",
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg, #ffffff)",
  color: "var(--text, #111827)",
};

export function DeviceFilters({
  platform,
  compliance,
  ownership,
  lastCheckIn,
  encrypted,
  search,
  onPlatformChange,
  onComplianceChange,
  onOwnershipChange,
  onLastCheckInChange,
  onEncryptedChange,
  onSearchChange,
}: DeviceFiltersProps) {
  return (
    <div style={containerStyle}>
      <input
        style={inputStyle}
        type="search"
        placeholder="Search devices…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Search devices"
      />
      <select
        style={inputStyle}
        value={platform}
        onChange={(e) => onPlatformChange(e.target.value)}
        aria-label="Filter by platform"
      >
        <option value="">All platforms</option>
        <option value="Windows">Windows</option>
        <option value="iOS">iOS</option>
        <option value="Android">Android</option>
        <option value="macOS">macOS</option>
      </select>
      <select
        style={inputStyle}
        value={compliance}
        onChange={(e) => onComplianceChange(e.target.value)}
        aria-label="Filter by compliance"
      >
        <option value="">All compliance</option>
        <option value="compliant">Compliant</option>
        <option value="noncompliant">Noncompliant</option>
      </select>
      <select
        style={inputStyle}
        value={ownership}
        onChange={(e) => onOwnershipChange(e.target.value)}
        aria-label="Filter by ownership"
      >
        <option value="">All ownership</option>
        <option value="company">Company</option>
        <option value="personal">Personal</option>
      </select>
      <select
        style={inputStyle}
        value={lastCheckIn}
        onChange={(e) => onLastCheckInChange(e.target.value)}
        aria-label="Filter by last check-in"
      >
        <option value="">Any time</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option>
      </select>
      <select
        style={inputStyle}
        value={encrypted}
        onChange={(e) => onEncryptedChange(e.target.value)}
        aria-label="Filter by encryption"
      >
        <option value="">Any encryption</option>
        <option value="true">Encrypted</option>
        <option value="false">Not encrypted</option>
      </select>
    </div>
  );
}
