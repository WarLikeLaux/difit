---
name: difit
description: Открывает изменения в viewer-е difit и интерактивно обрабатывает комментарии пользователя. Использовать только по явной просьбе открыть или запустить difit, провести review именно в difit либо при установленном требовании запрашивать review через difit после изменений.
---

# Difit

## Граница применения

Запускай viewer только при явном упоминании difit или при заранее установленном требовании проекта. Обычный запрос проверить diff не означает запуск внешнего viewer-а.

## Выбор команды

Сначала проверь `command -v difit`. Если команда доступна, используй `difit`; иначе — `npx difit`. Если fallback требует недоступной сети, сообщи о блокере.

Если доступны MCP tools плагина difit, предпочитай их для запуска viewer-а, чтения событий и работы с тредами. Они выполняют тот же workflow через типизированные аргументы. CLI-команды ниже остаются fallback, а также используются при отсутствии MCP.

Все команды выполняй из Git root выбранного checkout. Запуск viewer-а не разрешает сам по себе создавать или переключать ветки, выполнять fetch, merge, rebase либо менять index.

Основные targets:

- `difit .` — все текущие изменения;
- `difit . --include-untracked` — также новые файлы;
- `difit working` — только незакоммиченные tracked-изменения;
- `difit staged` — staging area;
- `difit` — HEAD;
- `difit <target> [base]` — конкретный commit или range.

Если используется `npx difit`, замени только имя команды, сохранив остальные аргументы.

## Identity и повторное использование

До запуска сохрани Git root, target/base и фактический port. Для одного Git root и target держи не более одного viewer-а.

Перед новым запуском проверь, не работает ли уже viewer того же review. Для live-target переиспользуй его: difit следит за изменениями рабочего дерева. Новый сервер нужен, только если изменился checkout или diff context.

Для повторных раундов используй `--keep-alive` или `--background`. Команды обратной связи всегда направляй на фактический port запущенного viewer-а.

## Комментарии

Читать и изменять треды следует штатными CLI-командами:

- `difit comment get --port <port> --format json`;
- `difit comment add --port <port> '<json>'`;
- `difit comment reply <thread-id> --port <port>`;
- `difit comment edit <thread-id> <message-id> --port <port>`;
- `difit comment accept <thread-id> --port <port>`;
- `difit comment verify <thread-id> --port <port>`;
- `difit comment ready <thread-id> --port <port>`.

MCP-эквиваленты: `get_comments`, `add_comment`, `reply`, `edit_message` и `set_thread_status`.

Текст ответа передавай через quoted heredoc, чтобы shell не изменил Markdown:

```bash
difit comment reply <thread-id> --port <port> <<'DIFIT_REPLY'
Текст ответа.
DIFIT_REPLY
```

После изменения кода выполни относящиеся проверки и ответь в исходном треде. Рабочий цикл статуса: `Open → Accepted → To verify → Ready → Resolved`. Агент не ставит `Resolved`: окончательно закрывает тред пользователь.

## HAPI wake-up inbox

Viewer, запущенный из HAPI-сессии, наследует её идентификатор и будит эту же сессию при новом или изменённом сообщении пользователя и при переходе треда в `To verify`. Для такого viewer-а не запускай watcher и не удерживай model turn.

После wake-сообщения получи durable batch:

```bash
difit comment events --port <port>
```

При доступном MCP вместо команды вызови `get_events` с тем же port.

Обработай все события из ответа. Только после полной обработки подтверди точный `throughSeq`:

```bash
difit comment ack <throughSeq> --port <port>
```

При доступном MCP вызови `ack_events` с port и точным `throughSeq`.

Не подтверждай batch заранее. Несколько сообщений объединяются за одним outstanding wake-up и не прерывают текущий turn. События новее подтверждаемого `throughSeq` остаются pending и вызывают следующий wake. Неподтверждённые события сохраняются и могут быть доставлены повторно после restart.

Используй этот режим только если viewer запущен из текущей HAPI-сессии или его привязка к ней достоверно известна.

## Watcher fallback

Если HAPI-привязки нет, используй один встроенный durable watcher:

```bash
difit comment watch --port <port> --cursor-file <cursor-file>
```

Отдельный cursor нужен для каждого review. Не добавляй поверх команды polling, второй restart-loop или дополнительный watcher. Пока идёт интерактивный review, продолжай читать вывод watcher-а; при паузе останови только watcher, оставив keep-alive viewer доступным для продолжения.

## Startup comments

Контекст или findings можно добавить при запуске несколькими аргументами `--comment`:

```bash
difit . --include-untracked \
  --comment '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","line":12},"body":"Комментарий"}'
```

Используй `side: "new"` для строк target и `side: "old"` для удалённых строк. Для диапазона передай `line: {"start": 12, "end": 16}`.

## Завершение

Если процесс завершился и вернул комментарии, продолжи работу над ними. Завершение без комментариев означает, что замечаний не было; повторно запускать viewer только ради проверки не нужно. Останавливай keep-alive viewer лишь по прямой просьбе пользователя.
