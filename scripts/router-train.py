"""Дообучение FunctionGemma 270M под навыки Ориона (первая ступень, src/core/router.js).

Порядок:
  npm run router-dataset -- --paraphrase 6     # data/router/{train,val}.jsonl из планов большой модели
  python scripts/router-train.py               # обучение → models/llm/orion-router-q8_0.gguf
  python scripts/router-train.py --init models/llm/orion-router-q8_0.gguf --lr 2e-5 --epochs 3
                                               # доучивание: старт с весов прошлой версии (из её GGUF), а не с исходной
  npm run router-eval -- --model orion-router-q8_0.gguf
  затем в config.json: "router": { "enabled": true, "model": "orion-router-q8_0.gguf" }

Окружение (один раз; ~3 ГБ, лучше вне папки OneDrive):
  python -m venv %USERPROFILE%\\.orion-train
  %USERPROFILE%\\.orion-train\\Scripts\\pip install torch --index-url https://download.pytorch.org/whl/cu128
  %USERPROFILE%\\.orion-train\\Scripts\\pip install transformers datasets accelerate gguf sentencepiece protobuf numpy

Полное дообучение (модель маленькая — LoRA не нужна): на RTX 5070 несколько минут.
Ошибка считается только по ответу модели (вызову или «передаю»), а не по промпту с описанием инструментов.
"""

import argparse
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

ROOT = Path(__file__).resolve().parent.parent
BASE = "unsloth/functiongemma-270m-it"  # те же веса, что у google/functiongemma-270m-it, без запроса доступа
# Сборка llama.cpp, встроенная в Орион (src/core/config.js → llamaCpp.build): конвертер берём той же версии
LLAMA_BUILD = re.search(r"llamaCpp:\s*\{\s*build:\s*'([^']+)'", (ROOT / "src" / "core" / "config.js").read_text(encoding="utf-8")).group(1)


def args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", default=str(ROOT / "data" / "router"))
    p.add_argument("--out", default=str(ROOT / "data" / "router" / "model"))
    p.add_argument("--gguf", default=str(ROOT / "models" / "llm" / "orion-router-q8_0.gguf"))
    p.add_argument("--epochs", type=float, default=4)
    p.add_argument("--lr", type=float, default=5e-5)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--accum", type=int, default=4)  # словарь Gemma — 262 тыс. токенов: логиты большого пакета не влезают в память
    p.add_argument("--max-len", type=int, default=1536)
    p.add_argument("--init", default="")  # GGUF прошлой версии: доучивать её, а не исходную FunctionGemma
    p.add_argument("--no-gguf", action="store_true")
    p.add_argument("--convert-only", action="store_true")  # только перевести уже обученную модель (--out) в GGUF
    return p.parse_args()


def load(path):
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


def encode(tok, row, max_len):
    """Промпт (developer + фраза + инструменты) без ошибки, ответ — с ошибкой."""
    msgs, tools = row["messages"], row.get("tools")  # без описаний — дообученная модель знает инструменты сама
    prompt = tok.apply_chat_template(msgs[:-1], tools=tools, add_generation_prompt=True, tokenize=False)
    full = tok.apply_chat_template(msgs, tools=tools, tokenize=False)
    if not full.startswith(prompt):
        raise ValueError("шаблон чата: ответ не продолжает промпт")
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    a_ids = tok(full[len(prompt):], add_special_tokens=False)["input_ids"]
    ids = (p_ids + a_ids)[:max_len]
    labels = ([-100] * len(p_ids) + a_ids)[:max_len]
    return {"input_ids": ids, "labels": labels}


class Collate:
    def __init__(self, pad):
        self.pad = pad

    def __call__(self, batch):
        n = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), n), self.pad, dtype=torch.long)
        labels = torch.full((len(batch), n), -100, dtype=torch.long)
        mask = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            k = len(b["input_ids"])
            ids[i, :k] = torch.tensor(b["input_ids"])
            labels[i, :k] = torch.tensor(b["labels"])
            mask[i, :k] = 1
        return {"input_ids": ids, "labels": labels, "attention_mask": mask}


def llama_converter():
    """convert_hf_to_gguf.py (с conversion/) и gguf-py той же сборки llama.cpp, что встроена в Орион (кэш в data/router)."""
    dest = ROOT / "data" / "router" / f"llama.cpp-{LLAMA_BUILD}"
    script = dest / "convert_hf_to_gguf.py"
    if not script.exists():
        url = f"https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/{LLAMA_BUILD}"
        print(f"Скачиваю конвертер llama.cpp {LLAMA_BUILD}…")
        data = urllib.request.urlopen(url, timeout=120).read()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                rel = name.split("/", 1)[1] if "/" in name else ""
                if rel == "convert_hf_to_gguf.py" or rel.startswith(("gguf-py/", "conversion/")):
                    target = dest / rel
                    if name.endswith("/"):
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(z.read(name))
    return script, dest / "gguf-py"


def main():
    a = args()
    random.seed(7)
    torch.manual_seed(7)
    train_rows, val_rows = load(Path(a.data) / "train.jsonl"), load(Path(a.data) / "val.jsonl")
    print(f"Примеров: обучение {len(train_rows)}, проверка {len(val_rows)}")

    tok = AutoTokenizer.from_pretrained(BASE)
    if a.init:
        # Веса из GGUF (q8_0) распаковываются в обычные float — дальше обучение как с исходной
        init = Path(a.init)
        model = AutoModelForCausalLM.from_pretrained(str(init.parent), gguf_file=init.name, dtype=torch.float32, attn_implementation="eager")
        model = model.to(torch.bfloat16)
        print(f"Доучиваю: {init.name}")
    else:
        model = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.bfloat16, attn_implementation="eager")
    train = [encode(tok, r, a.max_len) for r in train_rows]
    val = [encode(tok, r, a.max_len) for r in val_rows]
    call = next(i for i, r in enumerate(train_rows) if "tool_calls" in r["messages"][-1])
    print("Пример ответа для обучения:", tok.decode([t for t in train[call]["labels"] if t != -100]))

    trainer = Trainer(
        model=model,
        args=TrainingArguments(
            output_dir=str(Path(a.out) / "checkpoints"),
            num_train_epochs=a.epochs,
            per_device_train_batch_size=a.batch,
            gradient_accumulation_steps=a.accum,
            per_device_eval_batch_size=a.batch,
            learning_rate=a.lr,
            lr_scheduler_type="cosine",
            warmup_steps=max(1, int(0.05 * a.epochs * len(train) / (a.batch * a.accum))),
            weight_decay=0.01,
            bf16=torch.cuda.is_available(),
            logging_steps=10,
            eval_strategy="epoch",
            save_strategy="no",
            report_to=[],
            dataloader_num_workers=0,
        ),
        train_dataset=train,
        eval_dataset=val,
        data_collator=Collate(tok.pad_token_id),
    )
    trainer.train()
    print("Итог на проверке:", trainer.evaluate())
    model.save_pretrained(a.out, safe_serialization=True)
    copy_tokenizer(a.out)
    print(f"Модель: {a.out}")
    if not a.no_gguf:
        to_gguf(a.out, a.gguf)


def copy_tokenizer(out):
    """Токенизатор — исходные файлы базовой модели: словарь не менялся, а transformers 5 при сохранении
    дописывает служебные токены (262146 при 262144 в модели), и конвертер llama.cpp такой не принимает."""
    from huggingface_hub import snapshot_download

    base = Path(snapshot_download(BASE))
    for name in ["tokenizer.json", "tokenizer.model", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "chat_template.jinja"]:
        if (base / name).exists():
            shutil.copy(base / name, Path(out) / name)


def to_gguf(model_dir, gguf):
    script, gguf_py = llama_converter()
    Path(gguf).parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONPATH": str(gguf_py) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    subprocess.run([sys.executable, str(script), model_dir, "--outtype", "q8_0", "--outfile", gguf], check=True, env=env)
    print(f"Готово: {gguf}\nПроверка: npm run router-eval -- --model {Path(gguf).name}")


if __name__ == "__main__":
    a = args()
    if a.convert_only:
        copy_tokenizer(a.out)
        to_gguf(a.out, a.gguf)
    else:
        main()
