#!/usr/bin/env bash
# DO NOT MODIFY SCRIPT UNLESS EXPLICITLY TOLD TO

set -uo pipefail
IFS=$'\n\t'
umask 000

# ---------- PATHS ----------
WORKDIR="$(realpath "$(pwd)")"
OUTPUT_DIR="${OUTPUT_DIR_OVERRIDE:-$WORKDIR/__OUTPUTS__}"
STAGING_DIR="${STAGING_DIR_OVERRIDE:-$WORKDIR/__STAGING__}"
TMP_ROOT="/tmp/handbrake_safe"

TV_DIR="$OUTPUT_DIR/TV Shows"
MOVIE_DIR="$OUTPUT_DIR/Movies"

mkdir -p "$OUTPUT_DIR" "$STAGING_DIR" "$TMP_ROOT" "$TV_DIR" "$MOVIE_DIR"
# Permissions are managed by the web UI to support multi-user isolation
# chmod -R 777 "$OUTPUT_DIR" "$STAGING_DIR" 2>/dev/null || true

# ---------- DEP CHECK ----------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] Missing dependency: $1"
    exit 1
  }
}

need_cmd wget
need_cmd curl
need_cmd realpath
need_cmd file

HAS_HANDBRAKE=false
HAS_FILEBOT=false

command -v HandBrakeCLI >/dev/null && HAS_HANDBRAKE=true
command -v filebot >/dev/null && HAS_FILEBOT=true

# ---------- OPTIONS ----------
USE_FILEBOT=false
USE_HANDBRAKE=false
CONVERT_ONLY=false
FILEBOT_ONLY=false
FB_AUTO_PICK=true

if $HAS_FILEBOT; then
  read -rp "Use FileBot? (y/N): " fb
  if [[ ${fb,,} == "y" ]]; then
    USE_FILEBOT=true
    read -rp "Auto-pick matches? (y/N): " ap
    [[ ${ap,,} == "n" ]] && FB_AUTO_PICK=false
    read -rp "Run FileBot ONLY (no download/convert)? (y/N): " fbo
    [[ ${fbo,,} == "y" ]] && FILEBOT_ONLY=true
  fi
fi

if $HAS_HANDBRAKE && ! $FILEBOT_ONLY; then
  read -rp "Enable conversion (HandBrake)? (y/N): " hb
  [[ ${hb,,} == "y" ]] && USE_HANDBRAKE=true

  if $USE_HANDBRAKE; then
    read -rp "Convert ONLY existing MKVs? (y/N): " co
    [[ ${co,,} == "y" ]] && CONVERT_ONLY=true
  fi
fi

# ---------- INPUT ----------
if ! $CONVERT_ONLY && ! $FILEBOT_ONLY; then
  read -rp "Mode (M=Movie, S=Show): " mode
  mode=${mode^^}

  read -rp "URL: " url
  [[ -z "$url" ]] && exit 1

  base=$(echo "$url" | awk -F/ '{print $1 "//" $3}')
fi

# ---------- HELPERS ----------
urldecode() {
  python3 - "$1" <<'EOF'
import sys, urllib.parse
print(urllib.parse.unquote(sys.argv))
EOF
}

build_url() {
  local current_url="$1"
  local path_to_build="$2"

  [[ "$path_to_build" =~ ^http ]] && {
    echo "$path_to_build"
    return
  }

  [[ "$path_to_build" =~ ^/ ]] && {
    echo "$base$path_to_build"
    return
  }

  echo "${current_url%/}/$path_to_build"
}

countdown() {
  local delay=$((RANDOM % 10 + 10))
  echo "[Wait] Starting in $delay seconds..."
  for ((i=delay; i>0; i--)); do
    printf "\r[Wait] %2ds remaining...   " "$i"
    sleep 1
  done
  echo
}

is_media_file() {
  local f="$1"
  file "$f" | grep -qiE 'Matroska|MP4|AVI|MPEG|ISO Media'
}

has_local_episode() {
  local ep_tag="$1"
  local found
  # Search both base areas to avoid any redundant downloads across projects/users
  found=$(find "${BASE_STAGING:-$STAGING_DIR}" "${BASE_OUTPUTS:-$OUTPUT_DIR}" -type f -iname "*${ep_tag}*" -print -quit 2>/dev/null)
  
  if [[ -n "$found" ]]; then
    return 0
  fi
  return 1
}

# ---------- DOWNLOAD ----------
download_file() {
  local u="$1"

  echo
  echo "[Next] Preparing download..."
  echo "[DL] URL: $u"

  local downloaded="" name=""
  local ref_file
  
  # Set a flawless timestamp reference to track the downloaded file
  ref_file=$(mktemp "$STAGING_DIR/dl_ref.XXXXXX")
  touch "$ref_file"

  echo "[DL] Connecting..."

    if wget -c \
      -e robots=off \
      --content-disposition \
      --trust-server-names \
      --show-progress \
      --progress=dot:mega \
      --wait=10 \
      --random-wait \
      --tries=3 \
      --timeout=15 \
      --dns-timeout=10 \
      --connect-timeout=10 \
      --read-timeout=15 \
      --retry-on-http-error=429,500,502,503,504 \
      --header="User-Agent: Mozilla/5.0" \
      --header="Referer: $u" \
      -P "$STAGING_DIR" \
      "$u" 2>&1 | stdbuf -oL sed -u -e 's/.* \([0-9]\+\)% .*/[DL_PROGRESS] \1%/'; then

    downloaded=$(find "$STAGING_DIR" -maxdepth 1 -type f -newer "$ref_file" ! -name "$(basename "$ref_file")" -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
    
    rm -f "$ref_file"

    [[ -z "$downloaded" ]] && {
      echo "[✗] Unable to detect downloaded file"
      return 1
    }

    name=$(basename "$downloaded")
    
    if [[ "$name" == *%* ]]; then
      local decoded_name
      decoded_name=$(urldecode "$name")
      if [[ "$name" != "$decoded_name" ]]; then
        mv "$downloaded" "$STAGING_DIR/$decoded_name"
        downloaded="$STAGING_DIR/$decoded_name"
        name="$decoded_name"
        echo "[DL] Decoded filename to: $name"
      fi
    fi

    if file "$downloaded" | grep -qiE 'HTML|text'; then
      echo "[✗] Server returned HTML instead of media"
      echo "[✗] Discarding: $name"
      rm -f "$downloaded"
      return 1
    fi

    if ! is_media_file "$downloaded"; then
      echo "[✗] Download is not recognized as media"
      echo "[✗] Discarding: $name"
      rm -f "$downloaded"
      return 1
    fi

    echo "[✓] Download complete: $name"
    return 0

  else
    rm -f "$ref_file"
    echo "[✗] Download failed"
    return 1
  fi
}

# ---------- HANDBRAKE CONVERSION ----------
convert_tree() {
  echo
  echo "=========================================="
  echo "[HandBrake] Starting processing engine..."
  echo "=========================================="

  mapfile -d '' mkvs < <(
    find "$STAGING_DIR" -type f -iname "*.mkv" -print0
  )

  if (( ${#mkvs[@]} == 0 )); then
    echo "[HandBrake] No incoming MKV profiles detected."
    return
  fi

  for src in "${mkvs[@]}"; do
    local base_name
    base_name=$(basename "$src" .mkv)
    local dest="$STAGING_DIR/$base_name.mp4"
    local tmp_dest="$TMP_ROOT/$base_name.tmp.mp4"

    echo
    echo "[HandBrake] Transcoding: $base_name.mkv"
    
    if HandBrakeCLI -i "$src" -o "$tmp_dest" --preset="Fast 1080p30"; then
      mv "$tmp_dest" "$dest"
      rm -f "$src"
      echo "[✓] Transcode complete, original optimized out: $base_name.mp4"
    else
      echo "[✗] Dynamic conversion error encountered on: $base_name"
      rm -f "$tmp_dest"
    fi
  done
}

# ---------- FILEBOT ----------
run_filebot() {
  mapfile -d '' files < <(
    find "$OUTPUT_DIR" "$STAGING_DIR" -type f \
      \( -iname "*.mp4" -o -iname "*.mkv" \) \
      -print0
  )

  (( ${#files[@]} == 0 )) && {
    echo "[FileBot] No files found."
    return
  }

  declare -A groups

  for f in "${files[@]}"; do
    name=$(basename "$f")

    # FIXED: Replaced buggy Bash regex variables with rock-solid POSIX sed extraction
    # This cleanly slices off the S01E01 tag and everything after it, grouping all episodes properly.
    if echo "$name" | grep -qiE 's[0-9]{2}e[0-9]{2}'; then
      key=$(echo "$name" | sed -E 's/[ ._-]*[Ss][0-9]{2}[Ee][0-9]{2}.*//')
      # Fallback in case the filename was ONLY "S01E01.mkv" with no show name attached
      [[ -z "$key" ]] && key="${name%.*}"
    else
      key="${name%.*}"
    fi

    key="${key//./ }"

    key=$(echo "$key" | sed -E '
      s/\b(1080p|720p|480p|2160p)\b//Ig;
      s/\b(WEBRip|WEB-DL|BluRay|BRRip|HDRip|DVDRip|x264|x265|H264|H265)\b//Ig;
      s/[[:space:]]+/ /g;
      s/^ //;
      s/ $//;
    ')

    if [[ -z "${groups[$key]:-}" ]]; then
      groups["$key"]="$f"
    else
      groups["$key"]+=$'\n'"$f"
    fi
  done

  for key in "${!groups[@]}"; do
    echo
    echo "Group: $key"

    mapfile -t group_files <<< "${groups[$key]}"

    if $FILEBOT_ONLY; then
      if printf '%s\n' "${group_files[@]}" | grep -qiE 'S[0-9]{2}E[0-9]{2}'; then
        choice="S"
        echo "[Auto] Detected TV show"
      else
        read -rp "Type? (S=Show, M=Movie, Skip=Enter): " choice
        choice=${choice^^}
      fi
    else
      case "$mode" in
        S) choice="S" ;;
        M) choice="M" ;;
        *) choice="" ;;
      esac
      echo "[Auto] Using mode: $choice"
    fi

    case "$choice" in
      S)
        if $FB_AUTO_PICK; then
          filebot -rename "${group_files[@]}" \
            --db TheTVDB \
            -non-strict \
            --format "{ plex.id }" \
            --output "$OUTPUT_DIR" \
            --action move \
            --conflict skip
        else
          clean="$key"
          echo "[FileBot] Searching for Show: $clean"

          mapfile -t results < <(
            filebot -list \
              --db TheTVDB \
              --q "$clean" \
              --format "{n} ({y})" \
              2>/dev/null | sort -u
          )

          if (( ${#results[@]} == 0 )); then
            echo "[FileBot] No matches found for: $clean"
            continue
          fi

          # Auto-skip failure/no results
          if (( ${#results[@]} == 2 )) && [[ "${results[0]}" == "No search results" ]] && [[ "${results[1]}" == "Failure (×_×)⌒☆" ]]; then
            echo "[Skip] FileBot search returned no results/failure"
            continue
          fi

          echo "Select Show match:"
          echo " 0) Skip this group"
          for i in "${!results[@]}"; do
            printf "%2d) %s\n" $((i+1)) "${results[$i]}"
          done
          read -rp "Choice: " pick
          if [[ "$pick" == "0" ]]; then
            echo "[Skip] User skipped group"
            continue
          fi
          if [[ ! "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#results[@]} )); then
            echo "[Skip] Invalid selection"
            continue
          fi
          selected="${results[$((pick-1))]}"

          filebot -rename "${group_files[@]}" \
            --db TheTVDB \
            --q "$selected" \
            -non-strict \
            --format "{ plex.id }" \
            --output "$OUTPUT_DIR" \
            --action move \
            --conflict skip
        fi
        ;;

      M)
        clean="$key"
        clean=$(echo "$clean" | sed -E '
          s/\b(19|20)[0-9]{2}\b.*//I;
          s/\b(1080p|720p|480p|2160p)\b//Ig;
          s/\b(WEBRip|WEB-DL|BluRay|BRRip|HDRip|DVDRip|x264|x265|H264|H265|AAC|DDP5\.1)\b//Ig;
          s/[._-]+/ /g;
          s/[[:space:]]+/ /g;
          s/^ //;
          s/ $//;
        ')

        if $FB_AUTO_PICK; then
          echo "[FileBot] Auto-picking for Movie: $clean"
          filebot -rename "${group_files[@]}" \
            --db TheMovieDB \
            -non-strict \
            --q "$clean" \
            --format "Movies/{n} ({y})/{n} ({y})" \
            --output "$OUTPUT_DIR" \
            --action move \
            --conflict skip
          continue
        fi

        echo "[FileBot] Searching for: $clean"

        mapfile -t results < <(
          filebot -list \
            --db TheMovieDB \
            --q "$clean" \
            2>/dev/null
        )

        if (( ${#results[@]} == 0 )); then
          echo "[FileBot] No matches found for: $clean"
          continue
        fi

        # Auto-skip failure/no results
        if (( ${#results[@]} == 2 )) && [[ "${results[0]}" == "No search results" ]] && [[ "${results[1]}" == "Failure (×_×)⌒☆" ]]; then
          echo "[Skip] FileBot search returned no results/failure"
          continue
        fi

        if (( ${#results[@]} == 1 )); then
          selected="${results}"
          echo "[Auto] Using: $selected"
        else
          auto=""
          for r in "${results[@]}"; do
            r_clean=$(echo "$r" | sed -E 's/ \([0-9]{4}\)//')
            if [[ "${r_clean,,}" == "${clean,,}" ]]; then
              auto="$r"
              break
            fi
          done

          if [[ -n "$auto" ]]; then
            selected="$auto"
            echo "[Auto] Exact match: $selected"
          else
            echo "Select match:"
            echo " 0) Skip this group"
            for i in "${!results[@]}"; do
              printf "%2d) %s\n" $((i+1)) "${results[$i]}"
            done

            read -rp "Choice: " pick

            if [[ "$pick" == "0" ]]; then
              echo "[Skip] User skipped group"
              continue
            fi

            if [[ ! "$pick" =~ ^[0-9]+$ ]] || \
               (( pick < 1 || pick > ${#results[@]} )); then
              echo "[Skip] Invalid selection"
              continue
            fi
            selected="${results[$((pick-1))]}"
          fi
        fi

        filebot -rename "${group_files[@]}" \
          --db TheMovieDB \
          -non-strict \
          --q "$selected" \
          --format "Movies/{n} ({y})/{n} ({y})" \
          --output "$OUTPUT_DIR" \
          --action move \
          --conflict skip
        ;;
      *)
        echo "[Skip] $key"
        ;;
    esac
  done
}

# ---------- FILEBOT ONLY ENGINE ----------
if $FILEBOT_ONLY; then
  run_filebot
  echo "[✓] FileBot-only run complete."
  exit 0
fi

# ---------- MAIN RUN LOGIC ----------
if ! $CONVERT_ONLY; then
  countdown

  if [[ "$mode" == "M" ]]; then
    download_file "$url"

  elif [[ "$mode" == "S" ]]; then
    echo "[Scrape] Querying target root directory..."
    html=$(curl -Ls -H "User-Agent: Mozilla/5.0" "$url")

    url_path=$(echo "$url" | sed -E 's|^https?://[^/]+||')

    mapfile -t subfolders < <(
      echo "$html" |
      grep -oE 'href="[^"]+"' |
      cut -d'"' -f2 |
      grep -E '/$' |
      grep -vE '^\?|^\.\./|^\./|^/$' |
      grep -vi 'index.html'
    )

    declare -a targets_to_process=()
    
    for sf in "${subfolders[@]}"; do
      if [[ "$sf" == /* ]]; then
        if [[ "$sf" == "$url_path"* && "$sf" != "$url_path" ]]; then
          targets_to_process+=("$(build_url "$url" "$sf")")
        fi
      else
        targets_to_process+=("$(build_url "$url" "$sf")")
      fi
    done

    if (( ${#targets_to_process[@]} > 0 )); then
      echo "[Recursive] Detected subfolders. Sorting Season directories..."
      mapfile -t sorted_targets < <(printf "%s\n" "${targets_to_process[@]}" | sort -V)
      targets_to_process=("${sorted_targets[@]}")
    else
      echo "[Direct] No valid subfolders found. Parsing root directory directly."
      targets_to_process+=("$url")
    fi

    for target in "${targets_to_process[@]}"; do
      echo
      echo "=== Processing Location: $target ==="
      
      target_html=$(curl -Ls -H "User-Agent: Mozilla/5.0" "$target")
      
      mapfile -t links < <(
        echo "$target_html" |
        grep -oE 'href="[^"]+"' |
        cut -d'"' -f2 |
        grep -vi 'index\.html' |
        grep -Ei '\.(mkv|mp4|avi|mov)(\?.*)?$'
      )

      declare -A candidates
      for l in "${links[@]}"; do
        if [[ ${l^^} =~ (S[0-9]{2}E[0-9]{2}) ]]; then
          key="${BASH_REMATCH}"
          candidates["$key"]+=$'\n'"$l"
        fi
      done

      for k in $(printf "%s\n" "${!candidates[@]}" | sort); do
        echo
        echo "==============[$k]=============="
        echo "[Check] Looking for local file tagged with $k..."

        if has_local_episode "$k"; then
          echo "[Skip] Local copy of $k already detected in workspace. Skipping download."
          continue
        fi

        success=false
        mapfile -t episode_links <<< "${candidates[$k]}"

        sorted_links=$(
          printf "%s\n" "${episode_links[@]}" | awk '
            {
              # Resolution rank: 2160p=0, 1080p=1, 720p=2, 480p=3, others=9
              r=9; a=1;
              l=tolower($0);
              if (l ~ /2160p/) r=0;
              else if (l ~ /1080p/) r=1;
              else if (l ~ /720p/) r=2;
              else if (l ~ /480p/) r=3;
              
              # Audio rank: 5.1/7.1/DDP/AC3/EAC3/DTS=0, others=1, 2.0=2
              if (l ~ /[57]\.1|ddp|ac3|dts|eac3|truehd/) a=0;
              else if (l ~ /2\.0/) a=2;
              
              print r "|" a "|" $0
            }
          ' | sort -t"|" -k1,1n -k2,2n | cut -d"|" -f3-
        )

        while IFS= read -r link; do
          [[ -z "$link" ]] && continue

          full_url="$(build_url "$target" "$link")"
          echo "[Try] $full_url"

          if download_file "$full_url"; then
            success=true
            break
          else
            echo "[Fail] Trying next source option for $k"
          fi
        done <<< "$sorted_links"

        if ! $success; then
          echo "[Skip] No working mirrors/resolutions served for $k"
        fi

        countdown
      done
    done
  else
    echo "Invalid mode"
    exit 1
  fi
fi

$USE_HANDBRAKE && convert_tree
$USE_FILEBOT && run_filebot

echo "[✓] Done."