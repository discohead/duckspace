import React from 'react';

const steps = [
  'Open a new query tab to write and execute SQL',
  'Browse your data catalog to explore tables and schemas',
  'Use keyboard shortcuts: Cmd+T (new tab), Cmd+W (close tab)',
];

const WelcomeView: React.FC = () => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 40,
        textAlign: 'center',
      }}
    >
      <h1
        style={{
          fontSize: 32,
          fontWeight: 700,
          color: '#1f2937',
          margin: 0,
        }}
      >
        Datspace
      </h1>
      <p
        style={{
          fontSize: 16,
          color: '#6b7280',
          marginTop: 8,
        }}
      >
        Embedded Analytics Workbench
      </p>

      <div style={{ marginTop: 40, textAlign: 'left' }}>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: '#374151',
            margin: 0,
            marginBottom: 16,
          }}
        >
          Get Started
        </h2>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {steps.map((text, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  backgroundColor: '#3b82f6',
                  color: 'white',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </div>
              <span
                style={{
                  fontSize: 14,
                  color: '#4b5563',
                  marginLeft: 12,
                }}
              >
                {text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WelcomeView;
