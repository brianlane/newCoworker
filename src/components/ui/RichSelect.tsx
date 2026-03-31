"use client";

import { useEffect, useId, useRef, useState } from "react";

type RichSelectOption = {
  value: string;
  label: string;
};

type RichSelectProps = {
  label?: string;
  value: string;
  options: RichSelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
};

export function RichSelect({ label, value, options, placeholder = "Select an option", onChange }: RichSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openAbove, setOpenAbove] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const selectedOption = options.find((option) => option.value === value);
  const displayText = selectedOption?.label ?? placeholder;

  function toggleOpen() {
    if (!isOpen && buttonRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      const estimatedMenuHeight = Math.min(options.length * 40, 256);
      const spaceBelow = window.innerHeight - buttonRect.bottom;
      setOpenAbove(spaceBelow < estimatedMenuHeight && buttonRect.top > estimatedMenuHeight && window.innerWidth > 640);
    }

    setIsOpen((current) => !current);
  }

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchend", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchend", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      {label && (
        <label className="text-sm font-medium text-parchment/80">
          {label}
        </label>
      )}

      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          onClick={toggleOpen}
          className="relative w-full rounded-lg border border-parchment/20 bg-deep-ink/50 px-3 py-2 pr-10 text-left text-sm text-parchment transition-colors hover:bg-deep-ink/60 focus:outline-none focus:ring-2 focus:ring-signal-teal"
        >
          <span className={selectedOption ? "" : "text-parchment/40"}>
            {displayText}
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
            <svg
              viewBox="0 0 20 20"
              fill="none"
              className={["h-4 w-4 text-parchment/50 transition-transform", isOpen ? "rotate-180" : ""].join(" ")}
            >
              <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {isOpen && (
          <div
            id={listboxId}
            role="listbox"
            className={[
              "absolute z-50 max-h-64 w-full overflow-auto rounded-lg border border-parchment/15 bg-deep-ink shadow-xl ring-1 ring-black/20",
              openAbove ? "bottom-full mb-1" : "top-full mt-1"
            ].join(" ")}
          >
            {options.map((option) => {
              const isSelected = option.value === value;

              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                  className={[
                    "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors",
                    isSelected
                      ? "bg-signal-teal/10 text-parchment"
                      : "text-parchment/85 hover:bg-parchment/6"
                  ].join(" ")}
                >
                  <span>{option.label}</span>
                  {isSelected && (
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-signal-teal">
                      <path fillRule="evenodd" d="M16.704 5.29a1 1 0 0 1 .006 1.414l-8 8a1 1 0 0 1-1.416 0l-4-4A1 1 0 0 1 4.71 9.29L8 12.586l7.29-7.296a1 1 0 0 1 1.414 0Z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
