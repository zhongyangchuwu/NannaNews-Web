"""Build a static catalog from local PDF files."""
import argparse
import json
import sys

from .catalog import BuildError, build


def main():
    parser = argparse.ArgumentParser(prog='python -m nannaweb')
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('build')
    command.add_argument('--input-dir', required=True)
    command.add_argument('--output', default='.generated/site/data/catalog.json')
    command.add_argument('--cache', default='.cache/pdf')
    args = parser.parse_args()
    try:
        result = build(args.input_dir, args.output, args.cache)
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
