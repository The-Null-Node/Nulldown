/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { jest } from "@jest/globals";
import LibraryPalette from "./LibraryPalette";

describe("LibraryPalette", () => {
  it("renders and selects a distinct remote-library result", () => {
    const onOpenChange = jest.fn();
    const onSelectEntity = jest.fn();
    const onRefresh = jest.fn();
    render(
      <LibraryPalette
        open
        loading={false}
        groups={[
          {
            id: "remote-library",
            label: "Remote Library",
            entities: [
              {
                id: "drop-remote-a",
                type: "drop",
                title: "Nulldown remote-a",
                description: "Remote library metadata",
                keywords: ["remote"],
                value: { id: "remote-a" },
              },
            ],
          },
        ]}
        onOpenChange={onOpenChange}
        onSelectEntity={onSelectEntity}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("Remote Library (1)")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Nulldown remote-a/i }));
    expect(onSelectEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "drop-remote-a" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
