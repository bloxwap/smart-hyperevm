"use client";

import { Button } from "@bloxwap/hig-react/button";
import { useState } from "react";
import { CopyButton } from "./copy-button";

const installers = [
  { name: "bun", command: "bun add @bloxwap/hyperevm" },
  { name: "npm", command: "npm install @bloxwap/hyperevm" },
  { name: "pnpm", command: "pnpm add @bloxwap/hyperevm" },
  { name: "yarn", command: "yarn add @bloxwap/hyperevm" },
];

export function InstallCommand() {
  const [active, setActive] = useState(0);
  return (
    <div className="install-picker">
      <fieldset className="install-tabs hig-group" aria-label="Package manager">
        {installers.map((installer, index) => (
          <Button
            key={installer.name}
            intent={index === active ? "secondary" : "ghost"}
            aria-pressed={index === active}
            onClick={() => setActive(index)}
          >
            {installer.name}
          </Button>
        ))}
      </fieldset>
      <div className="install-command">
        <span aria-hidden="true">$</span>
        <code>{installers[active].command}</code>
        <CopyButton text={installers[active].command} label="Copy install command" className="install-copy" />
      </div>
    </div>
  );
}
