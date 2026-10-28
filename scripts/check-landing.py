#!/usr/bin/env python3
"""Check the static website's local links and HTML accessibility basics."""

import json
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1] / "landing"


class Page(HTMLParser):
    """Collect the attributes needed for link and document checks."""

    def __init__(self):
        super().__init__()
        self.links = []
        self.ids = set()
        self.h1 = 0
        self.errors = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes:
            self.ids.add(attributes["id"])
        if tag == "h1":
            self.h1 += 1
        if tag == "img" and "alt" not in attributes:
            self.errors.append("image missing alt")
        if tag == "iframe" and not (attributes.get("title") or "").strip():
            self.errors.append("iframe missing descriptive title")

        for key in ("href", "src"):
            if key in attributes:
                self.links.append(attributes[key])


def check_site(root=ROOT):
    """Return the report without changing files or making network requests."""
    config = json.loads((root / "vercel.json").read_text(encoding="utf-8"))
    redirects = {redirect["source"] for redirect in config["redirects"]}
    pages = {}
    sources = {}
    for path in root.rglob("*.html"):
        source = path.read_text(encoding="utf-8")
        page = Page()
        page.feed(source)
        pages[path] = page
        sources[path] = source

    issues = []
    checked = 0
    for path, page in pages.items():
        relative_path = path.relative_to(root)
        # Captured product pages keep their application structure. These
        # document-level checks apply to the public marketing documents.
        if "demo" not in relative_path.parts:
            issues.extend(f"{relative_path}: {error}" for error in page.errors)
            if "<main" in sources[path] and page.h1 != 1:
                issues.append(
                    f"{relative_path}: expected 1 h1, found {page.h1}"
                )

        for link in page.links:
            url = urlsplit(link)
            if url.scheme not in ("", "https", "http"):
                continue
            if url.netloc and url.netloc != "vigil-uptime.com":
                continue
            if url.path in redirects:
                continue

            if not url.path:
                destination = path
            elif url.path.startswith("/"):
                destination = root / url.path.lstrip("/")
            else:
                destination = path.parent / url.path
            destination = Path(unquote(str(destination))).resolve()
            if destination.is_dir():
                destination /= "index.html"

            checked += 1
            if not destination.exists():
                issues.append(f"{relative_path}: missing {link}")
            elif (
                url.fragment
                and destination in pages
                and unquote(url.fragment) not in pages[destination].ids
            ):
                issues.append(f"{relative_path}: missing fragment {link}")

    return {
        "html_pages": len(pages),
        "local_references_checked": checked,
        "issues": sorted(set(issues)),
    }


def main():
    report = check_site()
    print(json.dumps(report, indent=2))
    return bool(report["issues"])


if __name__ == "__main__":
    sys.exit(main())
