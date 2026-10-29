# pi-refusal-fallback

[English](README.md) · [CI](https://github.com/sehoon123/pi-refusal-fallback/actions/workflows/ci.yml)

Pi에서 제공자 거절 응답이 발생하면 **사용자가 지정한 순서대로 다른 모델에 재요청**하는 확장입니다.

**특정 제공자나 모델을 기본값으로 넣지 않았습니다. 설정하지 않으면 자동 fallback은 비활성입니다.** 처음 사용하는 모델은 평소처럼 Pi에서 선택하고, fallback 모델은 각자의 환경에 맞게 직접 지정합니다. 각 제공자의 정책과 인증·이용 제한은 그대로 적용됩니다.

## 설치

```sh
pi install git:github.com/sehoon123/pi-refusal-fallback@v0.1.0
```

이미 실행 중인 세션은 `/reload` 하세요. 기존 단일 파일 `refusal-fallback.ts`를 사용했다면 패키지와 **동시에 로드하지 마세요.** 패키지로 전환할 때 기존 파일을 자동 로드 디렉터리 밖으로 옮겨야 합니다.

Node.js 22.19 이상 및 actionable `agent_before_settle`을 지원하는 Pi가 필요합니다. 자동 테스트 대상은 Pi 1.2.0과 1.4.0입니다. Pi가 제공하는 모듈을 사용하며 별도 런타임 npm 의존성은 없습니다.

## 모델 설정

시작 모델은 `/model` 또는 `pi --model ...`로 선택합니다. 이 확장은 사용자가 지정한 fallback 목록만 사용하며 제공자·인증정보를 생성하거나 모델 ID를 임의로 바꾸지 않습니다.

### 개인 설정 파일

`<agent-dir>/refusal-fallback.json`을 만드세요. 기본 위치는 `~/.pi/agent/refusal-fallback.json`입니다.

```json
{
  "chain": [
    { "provider": "your-first-provider", "id": "your-first-fallback-model" },
    { "provider": "your-second-provider", "id": "your-second-fallback-model" }
  ]
}
```

위 값은 추천 모델이 아니라 **교체해야 하는 자리표시자**입니다. `pi --list-models`에서 실제 제공자와 모델 ID를 확인하고 순서대로 적으세요. 목록을 늘리거나 줄일 수 있으며 두 모델로 제한되지 않습니다.

- `PI_CODING_AGENT_DIR`를 지정했다면 해당 agent 디렉터리에 설정합니다.
- `PI_REFUSAL_FALLBACK_CONFIG=/absolute/path/to/config.json`으로 다른 파일을 사용할 수 있습니다. 상대 경로는 Pi 작업 디렉터리 기준이며 `~/`도 지원합니다.
- 최상위 필드는 `chain`만 허용하고 각 항목에는 비어 있지 않은 `provider`, `id` 문자열만 허용합니다.
- `{"chain": []}`는 자동 fallback을 비활성화합니다.
- 설정 파일은 설치된 패키지 저장소 밖에 보관하세요. 업데이트로 개인 설정이 덮어써지지 않습니다.
- 파일 수정 후 `/reload` 하세요.

[설정 예제](examples/refusal-fallback.example.json)도 제공합니다.

### 환경변수

```sh
export PI_REFUSAL_FALLBACK_CHAIN='your-provider/your-model-a,other-provider/organization/your-model-b'
pi
```

쉼표로 순서를 구분하고 **첫 번째 `/`만** 제공자와 모델의 구분자로 사용합니다. 따라서 모델 ID 내부의 추가 `/`는 보존됩니다. 잘못된 항목을 조용히 무시하거나 기본 모델로 대체하지 않습니다.

빈 환경변수는 설정 파일보다 우선하여 fallback을 끕니다.

```sh
PI_REFUSAL_FALLBACK_CHAIN='' pi
```

환경변수는 Pi를 시작한 프로세스에 설정되어 있어야 합니다. 다른 터미널에서 export해도 이미 실행 중인 Pi의 환경은 바뀌지 않습니다.

### 우선순위와 상태 확인

1. `PI_REFUSAL_FALLBACK_CHAIN` — 빈 값도 우선합니다.
2. `PI_REFUSAL_FALLBACK_CONFIG`로 선택한 파일.
3. 기본 `<agent-dir>/refusal-fallback.json`.
4. 설정 없음 — 비활성.

기본 파일이 없는 것은 정상입니다. 명시적으로 선택한 파일이 없거나 설정이 잘못된 경우 fallback만 비활성화하고 오류를 안내합니다. 일반 Pi 요청은 계속 사용할 수 있습니다.

대화형 세션에서 다음 명령으로 상태를 확인합니다. 모델 요청이나 설정 변경은 하지 않습니다.

```text
/refusal-fallback status
```

## 동작과 제한

- 완료된 assistant의 `rawStopReason: "refusal"` 또는 거절·정책 관련 오류를 감지합니다.
- 오류 경로에서 무시될 수 있는 `turn_end` 재시작 대신, `agent_before_settle`에서 실제 후속 요청을 시작합니다.
- 실패한 assistant 응답은 `context_edit`으로 후속 모델 컨텍스트에서만 제외합니다. 원본 이력과 사용량은 유지합니다.
- 현재 모델·중복 모델·이미 시도한 모델은 다시 시도하지 않습니다. 등록되지 않았거나 인증할 수 없는 모델은 건너뜁니다.
- 설정한 체인을 소진하면 마지막 거절을 남기고 멈춥니다. 무한 반복하지 않습니다.
- 중단된 요청은 재시작하지 않습니다. 완료·중단 후 원래 선택 모델과 thinking을 복원하며 전역 기본값은 바꾸지 않습니다.
- 새 사용자 실행에서는 체인 상태를 초기화합니다.
- 일반 성공이나 무관한 인증·할당량·네트워크 오류를 자동 전환 사유로 취급하지 않습니다. Pi 자체 재시도 정책은 별개입니다.
- 다른 확장이 먼저 제안한 경계 항목은 유지합니다. 별도의 제공자·라우팅 확장은 실제 백엔드 가용성과 허용 thinking 옵션에 영향을 줄 수 있습니다.

## 개인정보·비용·로그

fallback 제공자도 마지막 질문뿐 아니라 대화 컨텍스트를 받을 수 있습니다. 개인정보, 데이터 보관 위치, 비용, 이용약관 및 권한에 맞는 모델을 직접 선택하세요. 게이트웨이 접근 제한·모델 가용성·할당량을 우회하지 않습니다.

API 키·쿠키·요청 본문·프롬프트·응답 본문을 저장하거나 디버그 로그에 남기지 않습니다. 디버그 로그는 선택적으로 모델 ID와 실행 흐름만 기록합니다.

```sh
PI_REFUSAL_FALLBACK_DEBUG=1 pi
```

위치는 `<agent-dir>/refusal-fallback.log`이고 새 파일 권한은 `0600`입니다. 로그 기록 실패는 요청을 중단시키지 않으며 설정 오류에 입력 원문을 포함하지 않습니다.

## 개발 및 검증

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

자동 테스트는 메모리 기반 인증정보·모델 목록과 로컬 HTTP 서버만 사용하므로 실제 API 키나 유료 요청이 필요 없습니다. 설정 우선순위, 모델 ID, 연속 fallback, 체인 소진, 중복 방지, 인증 불가, 중단·복원, 새 실행 초기화, 컨텍스트 이력 보존, 서로 다른 API 간 전환을 검사합니다.

실제 `pi -p`와 비공개 게이트웨이로도 실제 거절 후 전환, 연속 두 번 fallback의 3회 반복, 체인 소진을 확인했습니다. 다중 전환 반복에서는 실제 API 응답 뒤 테스트용 거절 이벤트를 주입했습니다. 개인 제공자·모델 선택, 인증정보, 세션 원본 및 실호출 증적은 공개 저장소에 포함하지 않습니다. 특정 모델이나 게이트웨이의 가용성을 보장하는 것은 아닙니다.

## 라이선스

[MIT](LICENSE).
