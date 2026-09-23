"""Offline administration commands for pilot users and workspace memberships."""

from __future__ import annotations

import argparse
import getpass
import json
import stat
from collections.abc import Sequence
from pathlib import Path

from app.pilot.admin import bootstrap_admin
from app.pilot.auth import MEMBER_ROLES, ControlStore
from app.pilot.config import Settings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.pilot.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)

    workspace = subparsers.add_parser("init-workspace", help="create one empty pilot workspace")
    workspace.add_argument("--slug", required=True)
    workspace.add_argument("--name", required=True)

    user = subparsers.add_parser("create-user", help="create a user with an explicit password")
    user.add_argument("--username", required=True)
    user.add_argument("--display-name", required=True)
    user.add_argument(
        "--password-file",
        type=Path,
        help="read the password from a private file; otherwise prompt twice",
    )

    member = subparsers.add_parser("add-member", help="add or update a workspace member")
    member.add_argument("--workspace", required=True, help="workspace id or slug")
    member.add_argument("--username", required=True)
    member.add_argument("--role", required=True, choices=sorted(MEMBER_ROLES))

    admin = subparsers.add_parser(
        "create-admin", help="create an administrator with a generated password"
    )
    admin.add_argument("--username", required=True)
    admin.add_argument("--display-name", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = Settings.from_env()
    if (
        settings.mode != "pilot"
        or settings.control_db_path is None
        or settings.workspaces_dir is None
    ):
        raise SystemExit("admin commands require PRODUCT_RES_MODE=pilot")
    control = ControlStore(settings.control_db_path, settings.workspaces_dir)

    if args.command == "init-workspace":
        result = control.init_workspace(args.slug, args.name)
        _print_json({"id": result.id, "slug": result.slug, "name": result.name})
        return 0
    if args.command == "create-user":
        password = _read_password(args.password_file)
        _print_json(control.create_user(args.username, args.display_name, password))
        return 0
    if args.command == "add-member":
        _print_json(control.add_member(args.workspace, args.username, args.role))
        return 0
    if args.command == "create-admin":
        _print_json(bootstrap_admin(control, args.username, args.display_name))
        return 0
    raise AssertionError("unreachable command")


def _read_password(path: Path | None) -> str:
    if path is not None:
        resolved = path.expanduser().resolve()
        mode = resolved.stat().st_mode
        if mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise SystemExit("password file must not be accessible by group or others")
        password = resolved.read_text(encoding="utf-8").rstrip("\r\n")
    else:
        password = getpass.getpass("Password (12+ characters): ")
        repeated = getpass.getpass("Repeat password: ")
        if password != repeated:
            raise SystemExit("passwords do not match")
    if len(password) < 12:
        raise SystemExit("password must contain at least 12 characters")
    return password


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
