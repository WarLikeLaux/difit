# Настройка и обновление Difit в AI-агентах

Краткая памятка по сборке, обновлению и подключению Difit (MCP + Skill) к **Claude Code**, **Antigravity CLI** и **Cursor CLI**.

---

## 1. Как устроен сетап сейчас

Вся система завязана на **симлинки** прямо в эту папку (`~/code/difit`):

1. **Глобальный бинарник `difit`:**
   Установлен через `npm link` и указывает напрямую на `~/code/difit/dist/cli/index.js`.
2. **Скилл Difit:**
   Папки скиллов во всех агентах (`~/.claude/skills/difit`, `~/.gemini/config/skills/difit`, `~/.cursor/skills-cursor/difit`) являются симлинками на `plugins/difit/skills/difit`.

> **Главный вывод:** Ничего переустанавливать после правок не нужно!  
> Любые правки в коде или `SKILL.md` подхватываются агентами сразу после `pnpm run build`.

---

## 2. Как обновить Difit в повседневной работе

Если ты изменил код в репозитории или подтянул коммиты:

```bash
cd ~/code/difit
pnpm run build
```

Всё! С этого момента:

- Терминальная команда `difit` обновилась.
- MCP-серверы `difit` и `difit-reviewer` во всех агентах запускают обновлённый бинарник.
- Правки в `SKILL.md` агенты видят сразу (даже без пересборки).

---

## 3. Установка с нуля (новая машина / смена версии Node.js)

Если ты переключил версию Node через `nvm` или ставишься на чистую систему:

### Шаг 1: Сборка и глобальный линк CLI

```bash
cd ~/code/difit
pnpm install
pnpm run build
npm link    # привязывает команду difit к текущей версии node
```

Проверка:

```bash
which difit
difit --version
```

### Шаг 2: Пролинковать скилл в агенты

Запусти одну команду:

```bash
sync-agent-skills
```

_(Она создаст симлинки на скилл в Claude, Antigravity и Cursor)._

Если скрипта нет под рукой, вручную:

```bash
ln -sfn ~/code/difit/plugins/difit/skills/difit ~/.gemini/config/skills/difit
ln -sfn ~/code/difit/plugins/difit/skills/difit ~/.claude/skills/difit
ln -sfn ~/code/difit/plugins/difit/skills/difit ~/.cursor/skills-cursor/difit
```

### Шаг 3: Подключить MCP-серверы

Каждому агенту нужны две конфигурации:

- `difit` — полный режим для главного агента (управление тредами, ответы, фиксация правок).
- `difit-reviewer` — безопасный режим для ревьюеров (`--role reviewer`), где доступны только чтение и добавление комментариев.

#### Claude Code:

```bash
claude mcp add -s user difit -- difit mcp
claude mcp add -s user difit-reviewer -- difit mcp --role reviewer
```

#### Antigravity CLI (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "difit": {
      "command": "difit",
      "args": ["mcp"]
    },
    "difit-reviewer": {
      "command": "difit",
      "args": ["mcp", "--role", "reviewer"]
    }
  }
}
```

#### Cursor CLI (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "difit": {
      "type": "stdio",
      "command": "difit",
      "args": ["mcp"]
    },
    "difit-reviewer": {
      "type": "stdio",
      "command": "difit",
      "args": ["mcp", "--role", "reviewer"]
    }
  }
}
```

---

## 4. Уроки ревью

При закрытии треда difit сохраняет урок (код до, переписку, код после) в `~/.difit/lessons/`; уроки
переживают удаление review. Агент читает их перед задачей командой `difit lessons --repo <path>`
или MCP-инструментом `get_lessons`.
