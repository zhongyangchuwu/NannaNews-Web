"""Import local PDF evidence into a canonical catalog."""
import argparse
import json
import sys

from .catalog import BuildError, import_pdfs


def main():
    parser = argparse.ArgumentParser(prog='python -m nannaweb')
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('import')
    command.add_argument('--input-dir', required=True)
    command.add_argument('--catalog', required=True)
    command.add_argument('--cache', required=True)
    command.add_argument('--legacy-catalog')
    args = parser.parse_args()
    try:
        result = import_pdfs(args.input_dir, args.catalog, args.cache, args.legacy_catalog)
    except BuildError as exc:
        print(json.dumps({'error': exc.code, 'message': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (ValueError, TypeError, KeyError, AttributeError):
        print(json.dumps({'error': 'invalid_structure', 'message': 'The PDF extraction evidence is invalid.'}), file=sys.stderr)
        return 1
    except OSError:
        print(json.dumps({'error': 'filesystem_error', 'message': 'A local file could not be read or written.'}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
