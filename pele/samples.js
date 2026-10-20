// 比較用サンプル。key は URL の ?sample= にも使う。
window.SAMPLES = [
  {
    key: 'flowchart-ja',
    label: '日本語フローチャート',
    code: `flowchart TD
    A([申請受付]) --> B{書類に不備はあるか？}
    B -- はい --> C[申請者へ補正を依頼]
    C --> A
    B -- いいえ --> D[担当課で審査]
    D --> E{決裁区分}
    E -->|課長決裁| F[課長が承認]
    E -->|部長決裁| G[部長が承認]
    F --> H[(住民情報システムへ登録)]
    G --> H
    H --> I([交付通知を送付])`,
  },
  {
    key: 'sequence',
    label: 'シーケンス図',
    code: `sequenceDiagram
    autonumber
    actor 住民
    participant 窓口 as 窓口端末
    participant 基幹 as 基幹システム
    participant 連携 as 庁内連携基盤
    住民->>窓口: 転入届を提出
    窓口->>基幹: 住民票データを照会
    基幹-->>窓口: 照会結果
    alt 不備あり
        窓口-->>住民: 補正を依頼
    else 不備なし
        窓口->>基幹: 異動を登録
        基幹->>連携: 関係課へ連携
        Note over 基幹,連携: 夜間バッチで<br/>各業務システムへ反映
        連携-->>基幹: 連携完了
        窓口-->>住民: 受付完了を案内
    end`,
  },
  {
    key: 'class',
    label: 'クラス図',
    code: `classDiagram
    class Application["申請"] {
        +String 申請番号
        +Date 受付日
        +Status 状態
        +提出()
        +取下げ()
    }
    class Applicant["申請者"] {
        +String 氏名
        +String 住所
    }
    class Review["審査"] {
        +String 担当者
        +判定(結果) bool
    }
    class Status {
        <<enumeration>>
        受付
        審査中
        完了
    }
    class OnlineApplication["電子申請"]
    class PaperApplication["紙申請"]
    Applicant "1" --> "*" Application : 提出する
    Application "1" *-- "1..*" Review : 含む
    Application ..> Status
    OnlineApplication --|> Application
    PaperApplication --|> Application`,
  },
  {
    key: 'er',
    label: 'ER図',
    code: `erDiagram
    RESIDENT ||--o{ APPLICATION : "申請する"
    APPLICATION ||--|{ APPLICATION_ITEM : "含む"
    APPLICATION }o--|| DEPARTMENT : "担当する"
    DEPARTMENT ||--o{ STAFF : "所属"
    RESIDENT {
        string resident_id PK "住民番号"
        string name "氏名"
        date birth_date "生年月日"
        string address "住所"
    }
    APPLICATION {
        string application_id PK "申請番号"
        string resident_id FK "住民番号"
        string department_id FK "担当課"
        date received_at "受付日"
        string status "状態"
    }
    APPLICATION_ITEM {
        string application_id PK, FK "申請番号"
        int line_no PK "明細番号"
        string document_type "書類種別"
    }
    DEPARTMENT {
        string department_id PK "課コード"
        string name "課名"
    }
    STAFF {
        string staff_id PK "職員番号"
        string department_id FK "所属課"
        string name "氏名"
    }`,
  },
  {
    key: 'flowchart-complex',
    label: '複雑なフローチャート',
    code: `flowchart LR
    classDef ext fill:#fff4e5,stroke:#d97706,color:#7c2d12
    classDef warn fill:#fde8e8,stroke:#c81e1e

    subgraph 住民向け["住民向けチャネル"]
        direction TB
        W[Webフォーム] & M[スマホアプリ] & K[/窓口キオスク/]
    end

    subgraph 庁内["庁内ネットワーク"]
        direction TB
        GW{{API連携ゲートウェイ}}
        Q[(受付キュー)]
        subgraph 業務["業務システム群"]
            R1[住民記録]
            R2[税務]
            R3[福祉]
            R4[国保・年金]
        end
        AU[[監査ログ]]
    end

    subgraph 外部["外部連携"]
        J((マイナポータル)):::ext
        L>LGWAN-ASP]:::ext
    end

    W --> GW
    M --> GW
    K -.-> GW
    GW ==> Q
    Q --> R1 & R2 & R3 & R4
    R1 <--> R2
    R2 <-.-> R3
    R3 --o R4
    R4 --x E[エラー通知]:::warn
    GW -- 認証 --> J
    J -. 本人確認結果 .-> GW
    L ---|閉域接続| GW
    R1 & R2 & R3 & R4 --> AU
    AU --> 業務
    E -->|再送| Q`,
  },
];
